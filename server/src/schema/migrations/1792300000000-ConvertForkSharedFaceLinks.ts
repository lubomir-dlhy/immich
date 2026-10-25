import { Kysely, sql } from 'kysely';

type Link = { faceId: string; viewerGroupId: string; viewerId: string; faceGroupId: string | null; assetOwnerId: string };
type GroupRow = {
  personGroupId: string;
  ownerId: string;
  name: string;
  birthDate: Date | null;
  faceAssetId: string | null;
  isFavorite: boolean;
};

// Links that thin are usually misrecognitions, so they never merge two people.
const MIN_LINKS = 3;
const MIN_LINK_SHARE = 0.2;

class DisjointSet {
  private parent = new Map<string, string>();

  find(id: string): string {
    const parent = this.parent.get(id) ?? id;
    if (parent === id) {
      return id;
    }
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }

  union(a: string, b: string) {
    this.parent.set(this.find(b), this.find(a));
  }
}

const normalize = (name: string) => name.trim().toLowerCase();

export async function up(db: Kysely<any>): Promise<void> {
  const { rows: links } = await sql<Link>`
    SELECT DISTINCT ON (l."faceId", l."personId")
      l."faceId", l."personId" AS "viewerGroupId", p."ownerId" AS "viewerId",
      f."personGroupId" AS "faceGroupId", a."ownerId" AS "assetOwnerId"
    FROM "fork_shared_face_link" l
    INNER JOIN "asset_face" f ON f."id" = l."faceId" AND f."deletedAt" IS NULL
    INNER JOIN "asset" a ON a."id" = f."assetId"
    INNER JOIN "person" p ON p."personGroupId" = l."personId"
    WHERE a."ownerId" != p."ownerId"`.execute(db);

  if (links.length > 0) {
    await joinClusterGroups(db, links);
    const finalGroup = await mergePersonGroups(db, links);

    const unassigned = new Map<string, string[]>();
    for (const link of links) {
      if (link.faceGroupId) {
      	continue;
      }

      const target = finalGroup(link.viewerGroupId);
      unassigned.set(target, [...(unassigned.get(target) ?? []), link.faceId]);
    }
    for (const [personGroupId, faceIds] of unassigned) {
      await sql`UPDATE "asset_face" SET "personGroupId" = ${personGroupId}
        WHERE "id" = ANY(${faceIds}::uuid[]) AND "personGroupId" IS NULL`.execute(db);
    }
  }

  await sql`DROP TABLE "fork_shared_face_link";`.execute(db);
}

// Same effect as each linked user accepting a cluster group invite.
async function joinClusterGroups(db: Kysely<any>, links: Link[]) {
  const users = new DisjointSet();
  for (const { viewerId, assetOwnerId } of links) {
    users.union(viewerId, assetOwnerId);
  }

  const userIds = [...new Set(links.flatMap(({ viewerId, assetOwnerId }) => [viewerId, assetOwnerId]))];
  const { rows } = await sql<{ id: string; clusterGroupId: string; people: number }>`
    SELECT u."id", u."clusterGroupId", (SELECT count(*) FROM "person" p WHERE p."ownerId" = u."id")::int AS "people"
    FROM "user" u WHERE u."id" = ANY(${userIds}::uuid[])`.execute(db);

  const components = new Map<string, typeof rows>();
  for (const row of rows) {
    const root = users.find(row.id);
    components.set(root, [...(components.get(root) ?? []), row]);
  }

  for (const members of components.values()) {
    const target = members.toSorted((a, b) => b.people - a.people)[0].clusterGroupId;
    for (const clusterGroupId of new Set(members.map((member) => member.clusterGroupId))) {
      if (clusterGroupId !== target) {
        await sql`UPDATE "person_group" SET "clusterGroupId" = ${target} WHERE "clusterGroupId" = ${clusterGroupId}`.execute(
          db,
        );
      }
    }
    const ids = members.map((member) => member.id);
    await sql`UPDATE "user" SET "clusterGroupId" = ${target} WHERE "id" = ANY(${ids}::uuid[])`.execute(db);
  }
}

// Same effect as cross-user person merges: every user keeps their own person row and name.
async function mergePersonGroups(db: Kysely<any>, links: Link[]) {
  const edges = new Map<string, { a: string; b: string; count: number }>();
  for (const { viewerGroupId, faceGroupId } of links) {
    if (!faceGroupId || faceGroupId === viewerGroupId) {
      continue;
    }
    const [a, b] = [viewerGroupId, faceGroupId].toSorted();
    const edge = edges.get(`${a}:${b}`) ?? { a, b, count: 0 };
    edge.count++;
    edges.set(`${a}:${b}`, edge);
  }

  const groupIds = [...new Set(edges.values().flatMap(({ a, b }) => [a, b]))];
  const { rows: people } = await sql<GroupRow>`
    SELECT "personGroupId", "ownerId", "name", "birthDate", "faceAssetId", "isFavorite"
    FROM "person" WHERE "personGroupId" = ANY(${groupIds}::uuid[])`.execute(db);
  const { rows: faceCounts } = await sql<{ personGroupId: string; count: number }>`
    SELECT "personGroupId", count(*)::int AS "count" FROM "asset_face"
    WHERE "deletedAt" IS NULL AND "personGroupId" = ANY(${groupIds}::uuid[]) GROUP BY 1`.execute(db);
  const faces = new Map(faceCounts.map(({ personGroupId, count }) => [personGroupId, count]));

  // owner -> names they gave within the component, to avoid fusing two people one user told apart
  const ownerNames = new Map<string, Map<string, Set<string>>>();
  for (const person of people) {
    const names = new Map([[person.ownerId, new Set(person.name ? [normalize(person.name)] : [])]]);
    ownerNames.set(person.personGroupId, names);
  }

  const groups = new DisjointSet();
  const sortedEdges = edges.values().toArray().toSorted((x, y) => y.count - x.count);
  for (const { a, b, count } of sortedEdges) {
    const smaller = Math.min(faces.get(a) ?? 0, faces.get(b) ?? 0);
    if (count < MIN_LINKS || count < MIN_LINK_SHARE * smaller) {
      continue;
    }

    const [rootA, rootB] = [groups.find(a), groups.find(b)];
    if (rootA === rootB) {
      continue;
    }
    const namesA = ownerNames.get(rootA) ?? new Map<string, Set<string>>();
    const namesB = ownerNames.get(rootB) ?? new Map<string, Set<string>>();
    const conflict = [...namesB].some(([ownerId, names]) => new Set([...(namesA.get(ownerId) ?? []), ...names]).size > 1);
    if (conflict) {
      continue;
    }

    groups.union(rootA, rootB);
    for (const [ownerId, names] of namesB) {
      namesA.set(ownerId, new Set([...(namesA.get(ownerId) ?? []), ...names]));
    }
    ownerNames.set(rootA, namesA);
  }

  const components = new Map<string, string[]>();
  for (const id of groupIds) {
    const root = groups.find(id);
    components.set(root, [...(components.get(root) ?? []), id]);
  }

  const targets = new Map<string, string>();
  for (const [root, members] of components) {
    const [target, ...sources] = members.toSorted((a, b) => (faces.get(b) ?? 0) - (faces.get(a) ?? 0));
    targets.set(root, target);

    const targetOwners = new Set(people.filter((p) => p.personGroupId === target).map((p) => p.ownerId));
    for (const source of sources) {
      const sourcePeople = people.filter((p) => p.personGroupId === source);
      for (const person of sourcePeople) {
        if (targetOwners.has(person.ownerId)) {
          await sql`UPDATE "person" SET
              "name" = CASE WHEN "name" = '' THEN ${person.name} ELSE "name" END,
              "birthDate" = COALESCE("birthDate", ${person.birthDate}::date),
              "faceAssetId" = COALESCE("faceAssetId", ${person.faceAssetId}::uuid),
              "isFavorite" = "isFavorite" OR ${person.isFavorite}
            WHERE "ownerId" = ${person.ownerId} AND "personGroupId" = ${target}`.execute(db);
          await sql`DELETE FROM "person" WHERE "ownerId" = ${person.ownerId} AND "personGroupId" = ${source}`.execute(db);
        } else {
          await sql`UPDATE "person" SET "personGroupId" = ${target}
            WHERE "ownerId" = ${person.ownerId} AND "personGroupId" = ${source}`.execute(db);
          targetOwners.add(person.ownerId);
        }
      }
      await sql`UPDATE "asset_face" SET "personGroupId" = ${target} WHERE "personGroupId" = ${source}`.execute(db);
      await sql`DELETE FROM "person_group" WHERE "id" = ${source}`.execute(db);
    }
  }

  return (personGroupId: string) => targets.get(groups.find(personGroupId)) ?? personGroupId;
}

export async function down(): Promise<void> {
  // Not implemented: merged person groups cannot be split back
}
