import fs from 'node:fs';
import path from 'node:path';

// Small JSON-file store. Good enough for a single instance; swap for a database in production.
export class PaylinkStore {
  constructor(file) {
    this.file = file;
    this.items = new Map();
    if (file && fs.existsSync(file)) {
      for (const item of JSON.parse(fs.readFileSync(file, 'utf8'))) {
        this.items.set(item.id, item);
      }
    }
  }

  get(id) {
    return this.items.get(id) || null;
  }

  findBy(predicate) {
    for (const item of this.items.values()) {
      if (predicate(item)) return item;
    }
    return null;
  }

  save(item) {
    item.updatedAt = new Date().toISOString();
    this.items.set(item.id, item);
    this.#flush();
    return item;
  }

  #flush() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.items.values()], null, 2));
    fs.renameSync(tmp, this.file);
  }
}
