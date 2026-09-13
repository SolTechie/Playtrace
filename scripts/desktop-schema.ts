import { mkdirSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { gameInputSchema, themeInputSchema } from '../shared/schema';
const schema = JSON.stringify(
  { games: z.toJSONSchema(gameInputSchema), themes: z.toJSONSchema(themeInputSchema) },
  null,
  2,
);
mkdirSync('desktop/.build', { recursive: true });
writeFileSync('desktop/.build/schema.json', schema);
writeFileSync('desktop/.build/Schema.swift', `let embeddedSchema = ###"""\n${schema}\n"""###\n`);
