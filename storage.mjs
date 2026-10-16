import {validateExpense, validateBackup, APP_ID} from './core.mjs';
const DB_NAME = 'my-expenses-local-v1';
export function openLedger() {
  return new Promise((resolve,reject) => {
    const req = indexedDB.open(DB_NAME,1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('expenses', {keyPath:'id'});
      req.result.createObjectStore('meta');
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Закройте другие вкладки приложения и откройте его снова.'));
  });
}
function transaction(db,mode,work) {
  return new Promise((resolve,reject) => {
    const tx = db.transaction(['expenses','meta'],mode);
    let result;
    let failure;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(failure || tx.error || new Error('Не удалось сохранить данные.'));
    tx.onerror = () => {};
    const context = {
      expenses: tx.objectStore('expenses'),
      meta: tx.objectStore('meta'),
      result(value) {result = value;},
      fail(error) {failure = error; tx.abort();}
    };
    try {work(context);} catch (error) {context.fail(error);}
  });
}
function bump(meta) {
  const request = meta.get('changeCounter');
  request.onsuccess = () => meta.put((request.result || 0) + 1,'changeCounter');
}
export async function snapshot(db) {
  return transaction(db,'readonly',ctx => {
    const expenses = ctx.expenses.getAll();
    const meta = ctx.meta.getAll();
    const keys = ctx.meta.getAllKeys();
    keys.onsuccess = () => ctx.result({expenses:expenses.result,meta:Object.fromEntries(keys.result.map((key,i)=>[key,meta.result[i]]))});
  });
}
export async function saveExpense(db,raw,expectedRevision=null) {
  const expense = validateExpense(raw);
  return transaction(db,'readwrite',ctx => {
    const request = ctx.expenses.get(expense.id);
    request.onsuccess = () => {
      const current = request.result;
      if ((current?.revision ?? null) !== expectedRevision) return ctx.fail(new Error('Расход изменился в другой вкладке. Закройте форму и откройте её снова.'));
      ctx.expenses.put(expense);
      ctx.meta.put({currency:expense.currency,rate:expense.rate,category:expense.items[0].category},'defaults');
      bump(ctx.meta);
    };
  });
}
export async function removeExpense(db,id,expectedRevision) {
  return transaction(db,'readwrite',ctx => {
    const request = ctx.expenses.get(id);
    request.onsuccess = () => {
      if (request.result?.revision !== expectedRevision) return ctx.fail(new Error('Запись уже изменилась. Обновите историю.'));
      ctx.meta.put(request.result,'undoExpense');
      ctx.expenses.delete(id);
      bump(ctx.meta);
    };
  });
}
export async function undoRemove(db) {
  return transaction(db,'readwrite',ctx => {
    const request = ctx.meta.get('undoExpense');
    request.onsuccess = () => {
      const expense = request.result;
      if (!expense) return ctx.fail(new Error('Нет удалённой записи для восстановления.'));
      const existing = ctx.expenses.get(expense.id);
      existing.onsuccess = () => {
        if (existing.result) return ctx.fail(new Error('Расход с таким ID уже есть.'));
        ctx.expenses.put({...expense,revision:expense.revision+1});
        ctx.meta.delete('undoExpense');
        bump(ctx.meta);
      };
    };
  });
}
export async function importBackup(db,raw,mode='merge') {
  const backup = validateBackup(raw);
  if (!['merge','replace'].includes(mode)) throw new Error('Неизвестный режим импорта.');
  return transaction(db,'readwrite',ctx => {
    const request = ctx.expenses.getAll();
    request.onsuccess = () => {
      const existing = new Set(request.result.map(e=>e.id));
      if (mode === 'replace') {
        ctx.expenses.clear();
        ctx.meta.delete('undoExpense');
        ctx.meta.delete('defaults');
      }
      let added = 0, skipped = 0;
      for (const expense of backup.expenses) {
        if (mode === 'merge' && existing.has(expense.id)) {skipped++;continue;}
        ctx.expenses.put(expense);
        added++;
      }
      if (added || mode === 'replace') bump(ctx.meta);
      ctx.result({added,skipped});
    };
  });
}
export async function markBackup(db,counter) {
  return transaction(db,'readwrite',ctx => ctx.meta.put({at:new Date().toISOString(),counter},'lastBackup'));
}
export function backupDocument(expenses) {
  return {app:APP_ID,schemaVersion:1,exportedAt:new Date().toISOString(),expenses};
}
