export const CATEGORIES = ['Продукты','Кафе и рестораны','Транспорт','Жильё','Бытовые товары','Здоровье','Одежда','Развлечения','Связь','Услуги','Налоги и сборы','Другое'];
export const APP_ID = 'pocket-ledger';
export const MAX_MINOR = 1_000_000_000_000;
const fail = message => { throw new Error(message); };
export function moneyMinor(value) {
  const text = String(value).trim().replace(',', '.');
  if (!/^-?\d{1,10}(\.\d{1,2})?$/.test(text)) fail('Введите сумму: не больше двух знаков после запятой.');
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace('-', '').split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(result) || result > MAX_MINOR) fail('Сумма слишком велика.');
  return negative ? -result : result;
}
export function moneyText(minor) {
  if (!Number.isSafeInteger(minor)) fail('Некорректная сумма.');
  return (minor < 0 ? '-' : '') + Math.floor(Math.abs(minor) / 100) + '.' + String(Math.abs(minor) % 100).padStart(2, '0');
}
export function rateUnits(value) {
  const text = String(value).trim().replace(',', '.');
  if (!/^\d{1,6}(\.\d{1,8})?$/.test(text)) fail('Курс должен быть положительным числом, до 8 знаков после запятой.');
  const [whole, fraction = ''] = text.split('.');
  const units = BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, '0'));
  if (units <= 0n) fail('Курс должен быть больше нуля.');
  return units;
}
export function convertMinor(minor, rate) {
  if (!Number.isSafeInteger(minor)) fail('Некорректная сумма.');
  const product = BigInt(minor) * rateUnits(rate);
  const rounded = (product < 0n ? -1n : 1n) * ((product < 0n ? -product : product) + 50000000n) / 100000000n;
  const result = Number(rounded);
  if (!Number.isSafeInteger(result) || Math.abs(result) > MAX_MINOR) fail('Сумма в рублях слишком велика.');
  return result;
}
export function localDay(now = new Date()) {
  return [now.getFullYear(), String(now.getMonth()+1).padStart(2,'0'), String(now.getDate()).padStart(2,'0')].join('-');
}
export function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T12:00:00Z');
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0,10) === value && value >= '1900-01-01' && value <= '2199-12-31';
}
function text(value, max, label, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail('Некорректное поле: ' + label);
  return value;
}
function minor(value, label) {
  if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_MINOR) fail('Некорректная сумма: ' + label);
  return value;
}
export function sumMinor(items, key) {
  const result = items.reduce((sum, item) => sum + minor(item[key], key), 0);
  return minor(result, key);
}
export function recalculate(items, rate) {
  const totalMinor = sumMinor(items, 'amountMinor');
  if (totalMinor <= 0) fail('Итог расхода должен быть больше нуля.');
  const rubTotalMinor = convertMinor(totalMinor, rate);
  const result = items.map(item => ({...item, rubMinor: convertMinor(item.amountMinor, rate)}));
  const largest = result.reduce((best, item, i) => item.amountMinor > result[best].amountMinor ? i : best, 0);
  result[largest].rubMinor += rubTotalMinor - sumMinor(result, 'rubMinor');
  return {items: result, totalMinor, rubTotalMinor};
}
export function validateExpense(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Некорректная запись расхода.');
  const id = text(raw.id, 100, 'ID', true);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) fail('Некорректный ID.');
  if (!validDay(raw.date)) fail('Некорректная дата расхода.');
  const currency = text(raw.currency, 3, 'валюта', true);
  if (!/^[A-Z]{3}$/.test(currency)) fail('Некорректная валюта.');
  const rate = text(raw.rate, 20, 'курс', true);
  rateUnits(rate);
  if (currency === 'RUB' && rateUnits(rate) !== 100000000n) fail('Для RUB курс должен быть 1.');
  if (!Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > 200) fail('В расходе должно быть от 1 до 200 позиций.');
  const items = raw.items.map(item => {
    if (!item || typeof item !== 'object') fail('Некорректная позиция.');
    const quantity = text(item.quantity, 30, 'количество', true);
    if (!/^\d+(\.\d+)?$/.test(quantity) || !Number.isFinite(Number(quantity)) || Number(quantity) <= 0) fail('Количество должно быть больше нуля.');
    return {
      name: text(item.name, 500, 'название', true),
      category: text(item.category, 100, 'категория', true),
      quantity,
      amountMinor: minor(item.amountMinor, 'позиция'),
      rubMinor: minor(item.rubMinor, 'рубли'),
      originalName: text(item.originalName ?? item.name, 1000, 'оригинальное название')
    };
  });
  const totalMinor = minor(raw.totalMinor, 'итог');
  const rubTotalMinor = minor(raw.rubTotalMinor, 'итог в рублях');
  if (totalMinor <= 0 || sumMinor(items,'amountMinor') !== totalMinor || sumMinor(items,'rubMinor') !== rubTotalMinor) fail('Суммы позиций не совпадают с итогом расхода.');
  if (!Number.isSafeInteger(raw.revision) || raw.revision < 1) fail('Некорректная версия записи.');
  const result = {
    id, date: raw.date, currency, rate, items, totalMinor, rubTotalMinor,
    merchant: text(raw.merchant ?? '',500,'магазин'),
    note: text(raw.note ?? '',2000,'комментарий'),
    rateDate: text(raw.rateDate ?? '',30,'дата курса'),
    rateSource: text(raw.rateSource ?? '',200,'источник курса'),
    revision: raw.revision,
    createdAt: text(raw.createdAt ?? '',50,'дата создания'),
    updatedAt: text(raw.updatedAt ?? '',50,'дата изменения')
  };
  if (raw.sourceId !== undefined) result.sourceId = text(String(raw.sourceId),100,'исходный ID');
  if (raw.owner !== undefined) result.owner = text(String(raw.owner),100,'автор');
  return result;
}
export function validateBackup(raw) {
  if (!raw || raw.app !== APP_ID || raw.schemaVersion !== 1 || !Array.isArray(raw.expenses)) fail('Нужен JSON-файл резервной копии приложения «Мои расходы».');
  if (raw.expenses.length > 50000) fail('В файле больше 50 000 расходов.');
  const seen = new Set();
  const expenses = raw.expenses.map(value => {
    const expense = validateExpense(value);
    if (seen.has(expense.id)) fail('В файле повторяется ID: ' + expense.id);
    seen.add(expense.id);
    return expense;
  });
  return {app: APP_ID, schemaVersion: 1, expenses};
}
export function periodBounds(period, {from='',to='',now=new Date()} = {}) {
  if (period === 'today' || period === 'yesterday') {
    const day = new Date(now);
    if (period === 'yesterday') day.setDate(day.getDate()-1);
    return {from:localDay(day),to:localDay(day)};
  }
  if (period === 'custom') {
    if (!validDay(from) || !validDay(to) || from > to) fail('Выберите даты: начало периода не должно быть позже окончания.');
    return {from,to};
  }
  return {month:period};
}
export function normalizeCurrency(value) {
  const code=String(value).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) fail('Введите код валюты из трёх латинских букв, например MYR.');
  return code;
}
export function filterExpenses(expenses, {month='', from='', to='', query='', category=''} = {}) {
  const search = query.trim().toLocaleLowerCase('ru');
  return expenses.filter(expense => (!month || expense.date.startsWith(month)) &&
    (!from || expense.date >= from) && (!to || expense.date <= to) &&
    (!category || expense.items.some(item => item.category === category)) &&
    (!search || [expense.merchant, expense.note, ...expense.items.flatMap(item => [item.name,item.originalName,item.category])].join(' ').toLocaleLowerCase('ru').includes(search)))
    .sort((a,b) => b.date.localeCompare(a.date) || (Date.parse(b.createdAt)||0)-(Date.parse(a.createdAt)||0) || b.id.localeCompare(a.id,undefined,{numeric:true}));
}
export function totals(expenses) {
  const categories = new Map();
  let rubTotalMinor = 0;
  for (const expense of expenses) {
    rubTotalMinor += expense.rubTotalMinor;
    for (const item of expense.items) categories.set(item.category, (categories.get(item.category) || 0) + item.rubMinor);
  }
  return {rubTotalMinor, categories: [...categories].sort((a,b) => b[1]-a[1]), count: expenses.length};
}
export function csvExport(expenses) {
  const cell = value => {
    let str = String(value ?? '');
    if (/^[\s]*[=+@-]/.test(str) && typeof value !== 'number' && !/^-?\d+(?:[.,]\d+)?$/.test(str)) str = "'" + str;
    return '"' + str.replaceAll('"','""') + '"';
  };
  const rows = [['ID','Дата','Магазин','Комментарий','Товар','Категория','Количество','Сумма','Валюта','Курс','Рубли','Название в оригинале']];
  for (const e of expenses) for (const item of e.items) rows.push([e.id,e.date,e.merchant,e.note,item.name,item.category,item.quantity,moneyText(item.amountMinor).replace('.',','),e.currency,e.rate.replace('.',','),moneyText(item.rubMinor).replace('.',','),item.originalName]);
  return '\uFEFF' + rows.map(row => row.map(cell).join(';')).join('\r\n');
}
