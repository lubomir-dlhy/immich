import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Generated,
  Table,
  Timestamp,
  UpdateDateColumn,
} from '@immich/sql-tools';
import { UpdatedAtTrigger, UpdateIdColumn } from 'src/decorators';
import { SourceType } from 'src/enum';
import { asset_face_source_type } from 'src/schema/enums';
import { AssetFaceTable } from 'src/schema/tables/asset-face.table';
import { PersonTable } from 'src/schema/tables/person.table';

/**
 * Fork: per-viewer face assignments.
 *
 * `asset_face.personId` holds the asset owner's assignment (upstream behavior,
 * untouched). This join table holds ADDITIONAL assignments for other users who
 * can access the asset (album members, partners) — so a single detected face
 * can be recognized under each accessing user's own people catalog, without a
 * breaking change to the owner's path.
 */
@Table({ name: 'asset_face_person' })
@UpdatedAtTrigger('asset_face_person_updatedAt')
export class AssetFacePersonTable {
  @ForeignKeyColumn(() => AssetFaceTable, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: false,
    primary: true,
  })
  faceId!: string;

  @ForeignKeyColumn(() => PersonTable, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: false,
    primary: true,
  })
  personId!: string;

  @Column({ default: SourceType.MachineLearning, enum: asset_face_source_type })
  sourceType!: Generated<SourceType>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @UpdateIdColumn({ index: true })
  updateId!: Generated<string>;
}
