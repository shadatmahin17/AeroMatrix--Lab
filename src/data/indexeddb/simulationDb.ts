import type { SimulationRecord } from '../../simulation/contracts/SimulationMetadata';

const DB_NAME = 'aerolab_sim_db';
const DB_VERSION = 1;
const STORE_NAME = 'simulation_runs';

// Node/SSR/restricted-browser fallback store
const memoryFallback = new Map<string, SimulationRecord>();

function openSimulationDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'metadata.id' });
          store.createIndex('projectId', 'metadata.projectId', { unique: false });
          store.createIndex('createdAt', 'metadata.createdAt', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function idbSaveSimulationRecord(record: SimulationRecord): Promise<void> {
  memoryFallback.set(record.metadata.id, record);
  const db = await openSimulationDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function idbGetSimulationRecord(id: string): Promise<SimulationRecord | null> {
  const db = await openSimulationDb();
  if (!db) {
    return memoryFallback.get(id) ?? null;
  }

  return new Promise<SimulationRecord | null>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(id);
      req.onsuccess = () => resolve((req.result as SimulationRecord | undefined) ?? memoryFallback.get(id) ?? null);
      req.onerror = () => resolve(memoryFallback.get(id) ?? null);
    } catch {
      resolve(memoryFallback.get(id) ?? null);
    }
  });
}

export async function idbListSimulationRecordsByProject(projectId?: string): Promise<SimulationRecord[]> {
  const db = await openSimulationDb();
  const filterRecords = (records: SimulationRecord[]) => {
    const filtered = projectId
      ? records.filter((r) => (r.metadata.projectId ?? 'default') === projectId)
      : records;
    return filtered.sort((a, b) => b.metadata.createdAt.localeCompare(a.metadata.createdAt));
  };

  if (!db) {
    return filterRecords(Array.from(memoryFallback.values()));
  }

  return new Promise<SimulationRecord[]>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        const list = Array.isArray(req.result) ? (req.result as SimulationRecord[]) : [];
        resolve(filterRecords(list));
      };
      req.onerror = () => resolve(filterRecords(Array.from(memoryFallback.values())));
    } catch {
      resolve(filterRecords(Array.from(memoryFallback.values())));
    }
  });
}

export async function idbDeleteSimulationRecord(id: string): Promise<void> {
  memoryFallback.delete(id);
  const db = await openSimulationDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}
