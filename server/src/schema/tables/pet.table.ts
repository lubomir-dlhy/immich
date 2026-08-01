import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Generated,
  Index,
  PrimaryGeneratedColumn,
  Table,
  Timestamp,
  UpdateDateColumn,
} from '@immich/sql-tools';
import { UpdatedAtTrigger, UpdateIdColumn } from 'src/decorators';
import { AssetPetTable } from 'src/schema/tables/asset-pet.table';
import { UserTable } from 'src/schema/tables/user.table';

@Table('pet')
@Index({ columns: ['ownerId'] })
@UpdatedAtTrigger('pet_updatedAt')
export class PetTable {
  @PrimaryGeneratedColumn('uuid')
  id!: Generated<string>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  ownerId!: string;

  @Column({ default: '' })
  name!: Generated<string>;

  @Column({ type: 'character varying', default: 'pet' })
  species!: Generated<string>;

  @Column({ type: 'boolean', default: false })
  isHidden!: Generated<boolean>;

  @ForeignKeyColumn(() => AssetPetTable, { onDelete: 'SET NULL', nullable: true })
  featurePetAssetId!: string | null;

  @UpdateIdColumn({ index: true })
  updateId!: Generated<string>;
}
