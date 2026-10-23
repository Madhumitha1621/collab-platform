import 'reflect-metadata';
import 'dotenv/config';
import { DataSource, DataSourceOptions } from 'typeorm';
import { ENTITIES } from './entities';
import { InitialSchema1760500000000 } from './migrations/1760500000000-InitialSchema';

export function dataSourceOptions(url: string): DataSourceOptions {
  return {
    type: 'postgres',
    url,
    entities: ENTITIES,
    migrations: [InitialSchema1760500000000],
    synchronize: false,
  };
}

/** Used by the TypeORM CLI (npm run migration:run). */
export default new DataSource(dataSourceOptions(process.env.DATABASE_URL ?? ''));
