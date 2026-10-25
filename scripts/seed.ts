import { seedDatabase } from '../src/db/seed';

seedDatabase().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
