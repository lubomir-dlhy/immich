import {
  Column,
  ForeignKeyColumn,
  Generated,
  Index,
  PrimaryGeneratedColumn,
  Table,
  UpdateDateColumn,
} from '@immich/sql-tools';
import { UpdatedAtTrigger, UpdateIdColumn } from 'src/decorators';
import { AssetTable } from 'src/schema/tables/asset.table';
import { PetTable } from 'src/schema/tables/pet.table';

@Table({ name: 'asset_pet' })
@UpdatedAtTrigger('asset_pet_updatedAt')
@Index({ columns: ['assetId', 'petId'] })
@Index({ columns: ['petId', 'assetId'] })
@Index({ columns: ['assetId', 'trackId'] })
@Index({ columns: ['assetId', 'isRejected'] })
export class AssetPetTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  assetId!: string;

  @ForeignKeyColumn(() => PetTable, {
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  petId!: string | null;

  @Column({ type: 'integer' })
  imageWidth!: number;

  @Column({ type: 'integer' })
  imageHeight!: number;

  @Column({ type: 'integer' })
  boundingBoxX1!: number;

  @Column({ type: 'integer' })
  boundingBoxY1!: number;

  @Column({ type: 'integer' })
  boundingBoxX2!: number;

  @Column({ type: 'integer' })
  boundingBoxY2!: number;

  @Column({ type: 'real' })
  detectionScore!: number;

  @Column({ type: 'character varying', default: 'pet' })
  species!: Generated<string>;

  @Column({ type: 'integer', default: 0 })
  frameTimestampMs!: Generated<number>;

  @Column({ type: 'integer', nullable: true })
  frameDurationMs!: number | null;

  @Column({ type: 'uuid' })
  trackId!: string;

  @Column({ type: 'boolean', default: false })
  isRejected!: Generated<boolean>;

  @UpdateDateColumn()
  updatedAt!: Generated<Date>;

  @UpdateIdColumn()
  updateId!: Generated<string>;
}
