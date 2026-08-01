import { Column, ForeignKeyColumn, Index, Table } from '@immich/sql-tools';
import { AssetPetTable } from 'src/schema/tables/asset-pet.table';

@Table({ name: 'pet_search' })
@Index({
  name: 'pet_index',
  using: 'hnsw',
  expression: `embedding vector_cosine_ops`,
  with: 'ef_construction = 300, m = 16',
})
export class PetSearchTable {
  @ForeignKeyColumn(() => AssetPetTable, { onDelete: 'CASCADE', primary: true })
  petAssetId!: string;

  @Column({ type: 'vector', length: 512, synchronize: false })
  embedding!: string;
}
