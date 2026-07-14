import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'backend/data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getFilePath(name: string): string {
  return path.join(DATA_DIR, `${name}.json`);
}

export function readAll<T>(name: string, fallback: T[] = []): T[] {
  const f = getFilePath(name);
  if (!fs.existsSync(f)) {
    fs.writeFileSync(f, JSON.stringify(fallback, null, 2));
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(f, 'utf-8'));
  } catch (e) {
    return fallback;
  }
}

export function writeAll<T>(name: string, data: T[]): T[] {
  fs.writeFileSync(getFilePath(name), JSON.stringify(data, null, 2));
  return data;
}

export function append<T>(name: string, item: T): T {
  const arr = readAll<T>(name, []);
  arr.unshift(item);
  writeAll(name, arr);
  return item;
}

export function update<T extends { id: string | number }>(
  name: string,
  id: string | number,
  patch: Partial<T>
): T | null {
  const arr = readAll<T>(name, []);
  const idx = arr.findIndex((x: any) => x.id === id);
  if (idx === -1) return null;
  arr[idx] = { ...arr[idx], ...patch };
  writeAll(name, arr);
  return arr[idx];
}
