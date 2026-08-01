import { ForeignKeyColumn, Table } from '@immich/sql-tools';
import { AssetPetTable } from 'src/schema/tables/asset-pet.table';
import { PetTable } from 'src/schema/tables/pet.table';

/**
 * Per-viewer pet assignments for shared assets.
 *
 * `asset_pet.petId` remains the asset owner's assignment. This table stores
 * additional assignments for album members and partners, allowing the same
 * detected animal to resolve to a different pet catalog for each viewer.
 */
@Table({ name: 'asset_pet_identity' })
export class AssetPetIdentityTable {
  @ForeignKeyColumn(() => AssetPetTable, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: false,
    primary: true,
  })
  petAssetId!: string;

  @ForeignKeyColumn(() => PetTable, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: false,
    primary: true,
  })
  petId!: string;
}
