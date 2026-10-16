import {CATEGORIES,periodBounds,normalizeCurrency,localDay,validDay,moneyMinor,moneyText,rateUnits,recalculate,validateExpense,validateBackup,filterExpenses,totals,csvExport} from './core.mjs';
import {openLedger,snapshot,saveExpense,removeExpense,undoRemove,importBackup,markBackup,backupDocument} from './storage.mjs';
const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const colors = ['#8ca75b','#4a8270','#b7a275','#7695a3','#b88a79','#8f8bb4','#6c9c89','#b0a252'];
const icons = {'Продукты':'◒','Кафе и рестораны':'☕','Транспорт':'↗','Жильё':'⌂','Здоровье':'＋','Одежда':'◇','Развлечения':'☆'};
let db, expenses = [], metadata = {}, editing = null, pendingImport = null, toastTimer, installPrompt, writing = false;
let currentView = 'overview';
let editorDirty = false;
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('my-expenses-changes') : null;
const formatMoney = (minor,currency='RUB') => {
  try {return new Intl.NumberFormat('ru-RU',{style:'currency',currency,minimumFractionDigits:2,maximumFractionDigits:2}).format(minor/100);}
  catch {return moneyText(minor) + ' ' + currency;}
};
const formatDay = day => new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'short'}).format(new Date(day+'T12:00:00'));
const monthLabel = value => value ? new Intl.DateTimeFormat('ru-RU',{month:'long',year:'numeric'}).format(new Date(value+'-01T12:00:00')) : 'За всё время';
const allCategories = () => [...new Set([...CATEGORIES,...expenses.flatMap(e=>e.items.map(i=>i.category))])];
function toast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(()=>{$('toast').hidden=true;},5000);
}
function errorMessage(error) {return error instanceof Error ? error.message : 'Не удалось выполнить действие.';}
async function safe(action) {try {await action();} catch(error) {toast(errorMessage(error));}}
function switchView(view) {
  if (!['overview','history','reports','settings'].includes(view)) view = 'overview';
  currentView = view;
  document.querySelectorAll('.view').forEach(el=>{el.hidden=el.id!==view;});
  document.querySelectorAll('[data-view]').forEach(button=>{
    button.classList.toggle('active',button.dataset.view===view);
    if (button.dataset.view===view) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current');
  });
  if (location.hash !== '#'+view) history.replaceState(null,'','#'+view);
  window.scrollTo({top:0,behavior:'instant'});
}
function monthOptions(id,includeAll=true) {
  const select = $(id), previous=select.value;
  const months = [...new Set([localDay().slice(0,7),...expenses.map(e=>e.date.slice(0,7))])].sort().reverse();
  select.replaceChildren();
  if (includeAll) select.add(new Option('За всё время',''));
  select.add(new Option('Сегодня','today'));
  select.add(new Option('Вчера','yesterday'));
  select.add(new Option('Произвольный период','custom'));
  for (const month of months) select.add(new Option(monthLabel(month),month));
  select.value = [...select.options].some(o=>o.value===previous) ? previous : localDay().slice(0,7);
}
function selectedPeriod(prefix) {
  return periodBounds($(prefix+'-month').value,{from:$(prefix+'-from').value,to:$(prefix+'-to').value});
}
function periodRows(prefix,extra={}) {
  $(prefix+'-range').hidden=$(prefix+'-month').value!=='custom';
  try {
    const bounds=selectedPeriod(prefix);
    $(prefix+'-period-error').hidden=true;
    return filterExpenses(expenses,{...bounds,...extra});
  } catch(error) {
    $(prefix+'-period-error').textContent=errorMessage(error);
    $(prefix+'-period-error').hidden=false;
    return [];
  }
}
function periodLabel(prefix) {
  const value=$(prefix+'-month').value;
  if (value==='custom') return $(prefix+'-from').value+' ? '+$(prefix+'-to').value;
  if (value==='today') return 'Сегодня';
  if (value==='yesterday') return 'Вчера';
  return monthLabel(value);
}
function editorCurrency() {
  return $('expense-currency').value==='custom' ? $('custom-currency').value.trim().toUpperCase() : $('expense-currency').value;
}
function categoryRows(element,rows) {
  const summary = totals(rows);
  if (!summary.count) {element.innerHTML='<div class="empty">За этот период расходов пока нет.</div>';return;}
  const max = Math.max(...summary.categories.map(([,value])=>Math.abs(value)),1);
  element.innerHTML=summary.categories.map(([name,value],index)=>
    '<div class="category-row"><div class="category-line"><span class="category-name"><span class="category-dot" style="background:'+colors[index%colors.length]+'"></span>'+escape(name)+'</span><span class="category-amount">'+escape(formatMoney(value))+'</span></div><div class="bar-track"><div class="bar-fill" style="width:'+Math.max(0,Math.min(100,Math.abs(value)/max*100))+'%;background:'+colors[index%colors.length]+'"></div></div></div>').join('');
}
function expenseRows(element,rows) {
  if (!rows.length) {element.innerHTML='<div class="empty">Расходов не найдено.</div>';return;}
  element.innerHTML = rows.map(e=>{
    const category=e.items.length===1 ? e.items[0].category : e.items.length+' позиций';
    const title=e.merchant || (e.items.length===1 ? e.items[0].name : 'Покупка');
    return '<button type="button" class="expense" data-expense="'+escape(e.id)+'"><span class="expense-icon" aria-hidden="true">'+escape(icons[e.items[0].category]||'◇')+'</span><span class="expense-info"><span class="expense-title">'+escape(title)+'</span><span class="expense-meta">'+escape(formatDay(e.date)+' · '+category)+'</span></span><span class="expense-amount">'+escape(formatMoney(e.totalMinor,e.currency))+(e.currency!=='RUB'?'<small>'+escape(formatMoney(e.rubTotalMinor))+'</small>':'')+'</span></button>';
  }).join('');
}
function renderOverview() {
  const rows=periodRows('overview');
  $('summary-period').textContent=periodLabel('overview');
  const summary=totals(rows);
  $('summary-total').textContent=formatMoney(summary.rubTotalMinor);
  $('summary-count').textContent=summary.count+' расходов';
  $('welcome').hidden=expenses.length>0;
  categoryRows($('overview-categories'),rows);
  expenseRows($('recent'),rows.slice(0,5));
}
function renderHistory() {
  const rows=periodRows('history',{query:$('search').value,category:$('history-category').value});
  $('history-count').textContent=rows.length+' расходов · '+formatMoney(totals(rows).rubTotalMinor)+( $('history-category').value ? ' · итог целых покупок' : '');
  expenseRows($('history-list'),rows);
}
function renderReports() {
  const rows=periodRows('report');
  $('report-total').textContent=formatMoney(totals(rows).rubTotalMinor);
  $('report-count').textContent=rows.length+' расходов';
  categoryRows($('report-categories'),rows);
}
function renderBackup() {
  const last=metadata.lastBackup;
  const dirty=(metadata.changeCounter||0)!==(last?.counter??-1);
  const overdue=!last || Date.now()-new Date(last.at).valueOf()>7*86400000;
  $('backup-reminder').hidden=!expenses.length || (!dirty&&!overdue);
  $('backup-reminder-text').textContent=last ? 'После последней выгрузки есть изменения или прошла неделя.' : 'На телефоне пока единственная копия вашей истории.';
  $('backup-date').textContent=last ? 'Последняя выгрузка: '+new Date(last.at).toLocaleString('ru-RU')+(dirty?' · есть новые изменения':'') : 'Резервная копия ещё не выгружалась.';
  $('undo-panel').hidden=!metadata.undoExpense;
}
async function refresh() {
  const state=await snapshot(db);
  expenses=state.expenses;metadata=state.meta;
  for (const id of ['overview-month','history-month','report-month']) monthOptions(id);
  const old=$('history-category').value;
  $('history-category').replaceChildren(new Option('Все категории',''));
  for (const category of allCategories()) $('history-category').add(new Option(category,category));
  $('history-category').value=allCategories().includes(old)?old:'';
  renderOverview();renderHistory();renderReports();renderBackup();
}
async function changed() {await refresh();channel?.postMessage('changed');}
function itemCard(item={},index=0) {
  const wrapper=document.createElement('div');wrapper.className='item-card';
  const selected=item.category||metadata.defaults?.category||'Продукты';
  const categories=[...new Set([...allCategories(),selected])];
  wrapper.innerHTML='<div class="item-header"><strong>Позиция <span class="item-number">'+(index+1)+'</span></strong><button type="button" class="text-button remove-item">Убрать</button></div>'+
    '<label>Название<input class="item-name" required maxlength="500" placeholder="Например, обед" value="'+escape(item.name||'')+'"></label>'+
    '<label>Категория<select class="item-category">'+categories.map(name=>'<option'+(name===selected?' selected':'')+'>'+escape(name)+'</option>').join('')+'</select></label>'+
    '<div class="form-row"><label>Количество<input class="item-quantity" required inputmode="decimal" value="'+escape(item.quantity||'1')+'"></label><label>Сумма позиции<input class="item-amount" required inputmode="decimal" placeholder="0,00" value="'+(item.amountMinor!==undefined?moneyText(item.amountMinor):'')+'"></label></div>';
  wrapper.dataset.originalName=item.originalName||'';
  return wrapper;
}
function updateItemNumbers() {
  const cards=[...$('editor-items').children];
  cards.forEach((card,i)=>{
    card.querySelector('.item-number').textContent=i+1;
    card.querySelector('.remove-item').disabled=cards.length===1;
  });
}
function readItems() {
  return [...$('editor-items').children].map(card=>({
    name:card.querySelector('.item-name').value.trim(),
    category:card.querySelector('.item-category').value,
    quantity:card.querySelector('.item-quantity').value.trim().replace(',','.'),
    amountMinor:moneyMinor(card.querySelector('.item-amount').value),
    rubMinor:0,
    originalName:card.dataset.originalName||card.querySelector('.item-name').value.trim()
  }));
}
function previewTotal() {
  try {
    const currency=editorCurrency();
    const total=recalculate(readItems(),currency==='RUB'?'1':$('expense-rate').value);
    $('editor-total').textContent=formatMoney(total.totalMinor,currency)+(currency==='RUB'?'':' ≈ '+formatMoney(total.rubTotalMinor));
  } catch {$('editor-total').textContent='Заполните суммы и курс';}
}
function syncCurrency() {
  const custom=$('expense-currency').value==='custom';
  $('custom-currency-label').hidden=!custom;
  $('custom-currency').required=custom;
  $('custom-currency').disabled=!custom;
  const currency=editorCurrency();
  $('rate-currency').textContent=currency;
  $('expense-rate').disabled=currency==='RUB';
  if (currency==='RUB') $('expense-rate').value='1';
  else if (editing?.currency===currency) $('expense-rate').value=editing.rate;
  else $('expense-rate').value=metadata.defaults?.currency===currency?metadata.defaults.rate:'';
  $('rate-note').textContent=currency==='RUB'?'Расход в рублях: пересчёт не нужен.':'Курс вводится вручную. Сохранённое значение не является актуальной котировкой.';
  previewTotal();
}
function openEditor(id=null) {
  editing=id?expenses.find(e=>e.id===id):null;
  if (id&&!editing) return toast('Запись не найдена. Обновите историю.');
  $('expense-form').reset();
  $('editor-title').textContent=editing?'Изменить расход':'Новый расход';
  $('delete-expense').hidden=!editing;
  $('form-error').hidden=true;
  $('expense-date').value=editing?.date||localDay();$('expense-date').max=localDay();
  $('expense-merchant').value=editing?.merchant||'';
  $('expense-note').value=editing?.note||'';
  const currency=editing?.currency||metadata.defaults?.currency||'THB';
  for (const code of new Set([currency,...expenses.map(e=>e.currency)])) {
    if (![...$('expense-currency').options].some(o=>o.value===code)) $('expense-currency').add(new Option(code,code),$('expense-currency').options.length-1);
  }
  $('expense-currency').value=currency;
  $('editor-items').replaceChildren(...(editing?.items||[{}]).map(itemCard));
  updateItemNumbers();syncCurrency();
  if (editing) $('editor-total').textContent=formatMoney(editing.totalMinor,editing.currency)+' · '+formatMoney(editing.rubTotalMinor);
  editorDirty=false;
  $('editor').showModal();
}
function closeEditor() {
  if (writing) return;
  if (editorDirty&&!confirm('Закрыть форму без сохранения изменений?')) return;
  $('editor').close();editing=null;editorDirty=false;
}
function buildExpense() {
  const date=$('expense-date').value;
  if (!validDay(date)||date>localDay()) throw new Error('Выберите существующую дату не позднее сегодняшней.');
  const currency=normalizeCurrency(editorCurrency());
  const rate=currency==='RUB'?'1':$('expense-rate').value.trim().replace(',','.');
  rateUnits(rate);
  let items=readItems(), calculated;
  const unchanged=editing && editing.currency===currency && rateUnits(editing.rate)===rateUnits(rate) &&
    items.length===editing.items.length && items.every((item,index)=>item.amountMinor===editing.items[index].amountMinor);
  if (unchanged) calculated={items:items.map((item,index)=>({...item,rubMinor:editing.items[index].rubMinor})),totalMinor:editing.totalMinor,rubTotalMinor:editing.rubTotalMinor};
  else calculated=recalculate(items,rate);
  const now=new Date().toISOString();
  return validateExpense({
    ...(editing||{}),id:editing?.id||crypto.randomUUID(),date,currency,rate,
    merchant:$('expense-merchant').value.trim(),note:$('expense-note').value.trim(),
    ...calculated,rateDate:unchanged?editing.rateDate:date,
    rateSource:unchanged?editing.rateSource:'Введён вручную',
    revision:(editing?.revision||0)+1,createdAt:editing?.createdAt||now,updatedAt:now
  });
}
function download(name,content,type) {
  const blob=new Blob([content],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=name;document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),60000);
}
async function exportBackup() {
  const state=await snapshot(db);
  download('expenses-backup-'+localDay()+'.json',JSON.stringify(backupDocument(state.expenses),null,2),'application/json;charset=utf-8');
  await markBackup(db,state.meta.changeCounter||0);await refresh();
  toast('Копия выгружена. Проверьте файл в «Загрузках» и сохраните в Google Drive.');
}
function exportCSV(all=false) {
  if (!all) selectedPeriod('report');
  const rows=all?filterExpenses(expenses):periodRows('report');
  download('expenses-'+(all?'all':$('report-month').value||'all')+'.csv',csvExport(rows),'text/csv;charset=utf-8');
  toast('CSV выгружен. Для восстановления используйте JSON-копию.');
}
async function prepareImport(file) {
  if (!file) return;
  if (file.size>30*1024*1024) throw new Error('Файл больше 30 МБ.');
  let raw;
  try {raw=JSON.parse(await file.text());} catch {throw new Error('Не удалось прочитать JSON-файл.');}
  const data=validateBackup(raw), mode=$('import-mode').value;
  const current=await snapshot(db), existing=new Set(current.expenses.map(e=>e.id));
  const duplicateCount=data.expenses.filter(e=>existing.has(e.id)).length;
  const dates=data.expenses.map(e=>e.date).sort();
  pendingImport={data,mode};
  $('import-summary').innerHTML='<p><strong>'+data.expenses.length+' расходов</strong> · '+data.expenses.reduce((n,e)=>n+e.items.length,0)+' позиций</p>'+
    '<p>Сумма: <strong>'+escape(formatMoney(totals(data.expenses).rubTotalMinor))+'</strong></p>'+
    (dates.length?'<p>Период: '+escape(dates[0])+' — '+escape(dates.at(-1))+'</p>':'')+
    '<p>'+(mode==='merge'?'Новых расходов: '+(data.expenses.length-duplicateCount)+'. Существующих ID: '+duplicateCount+' — они будут пропущены.':'Будет заменена вся текущая история: '+current.expenses.length+' расходов.')+'</p>';
  $('import-warning').textContent=mode==='replace'?'Перед заменой скачайте резервную копию. Текущие записи будут заменены данными из файла.':'Импорт добавит только новые ID. Повторный импорт этого же файла не создаст дубликатов.';
  $('import-error').hidden=true;
  $('confirm-import').disabled=false;
  $('import-preview').showModal();
}
async function persistState() {
  const supported=Boolean(navigator.storage?.persisted&&navigator.storage?.persist);
  const persistent=supported&&await navigator.storage.persisted();
  $('persist-state').textContent=persistent?'Постоянное хранение разрешено браузером. Резервные копии всё равно нужны.':supported?'Браузер пока не предоставил постоянное хранение. Установите приложение и запросите его.':'Этот браузер не поддерживает запрос постоянного хранения.';
  $('persist').hidden=!supported||persistent;
}
function wire() {
  document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>switchView(button.dataset.view)));
  document.addEventListener('click',event=>{
    const expense=event.target.closest('[data-expense]');
    if (expense) return openEditor(expense.dataset.expense);
    const action=event.target.closest('[data-action]')?.dataset.action;
    if (action==='new') openEditor();
    else if (action==='backup') safe(exportBackup);
    else if (action==='import') {$('import-file').value='';$('import-file').click();}
    else if (action) switchView(action);
  });
  for (const id of ['overview-month','history-month','history-category','report-month']) $(id).addEventListener('change',()=>{renderOverview();renderHistory();renderReports();});
  for (const prefix of ['overview','history','report']) {
    for (const side of ['from','to']) {
      $(prefix+'-'+side).value=localDay();
      $(prefix+'-'+side).addEventListener('change',()=>{renderOverview();renderHistory();renderReports();});
    }
  }
  $('search').addEventListener('input',renderHistory);
  $('close-editor').addEventListener('click',closeEditor);
  $('editor').addEventListener('cancel',event=>{event.preventDefault();closeEditor();});
  $('expense-form').addEventListener('input',()=>{editorDirty=true;previewTotal();});
  $('expense-currency').addEventListener('change',()=>{editorDirty=true;syncCurrency();});
  $('custom-currency').addEventListener('input',()=>{editorDirty=true;syncCurrency();});
  $('add-item').addEventListener('click',()=>{
    if ($('editor-items').children.length>=200) return toast('Не больше 200 позиций.');
    $('editor-items').append(itemCard({},$('editor-items').children.length));updateItemNumbers();editorDirty=true;
  });
  $('editor-items').addEventListener('click',event=>{
    if (!event.target.closest('.remove-item')) return;
    if ($('editor-items').children.length<=1) return;
    event.target.closest('.item-card').remove();updateItemNumbers();previewTotal();editorDirty=true;
  });
  $('expense-form').addEventListener('submit',async event=>{
    event.preventDefault();if(writing)return;
    writing=true;$('save-expense').disabled=true;$('form-error').hidden=true;
    try {
      const value=buildExpense();
      await saveExpense(db,value,editing?.revision??null);
      $('editor').close();editing=null;editorDirty=false;
      await changed();toast('Расход сохранён на устройстве.');
    } catch(error) {$('form-error').textContent=errorMessage(error);$('form-error').hidden=false;}
    finally {writing=false;$('save-expense').disabled=false;}
  });
  $('delete-expense').addEventListener('click',()=>safe(async()=>{
    if(writing||!editing||!confirm('Удалить этот расход? Последнюю удалённую запись можно восстановить в разделе «Данные».'))return;
    writing=true;
    try {await removeExpense(db,editing.id,editing.revision);$('editor').close();editing=null;editorDirty=false;await changed();toast('Расход удалён. Восстановление доступно в разделе «Данные».');}
    finally {writing=false;}
  }));
  $('undo').addEventListener('click',()=>safe(async()=>{await undoRemove(db);await changed();toast('Расход восстановлен.');}));
  $('csv-all').addEventListener('click',()=>safe(()=>exportCSV(true)));
  $('csv-period').addEventListener('click',()=>safe(()=>exportCSV(false)));
  $('import-file').addEventListener('change',event=>safe(()=>prepareImport(event.target.files[0])));
  const closeImport=()=>{if(writing)return;$('import-preview').close();pendingImport=null;};
  $('close-import').addEventListener('click',closeImport);$('cancel-import').addEventListener('click',closeImport);
  $('import-preview').addEventListener('cancel',event=>{event.preventDefault();closeImport();});
  $('confirm-import').addEventListener('click',async()=>{
    if(writing||!pendingImport)return;
    if(pendingImport.mode==='replace'&&!confirm('Заменить текущую историю? Убедитесь, что её резервная копия сохранена.'))return;
    writing=true;$('confirm-import').disabled=true;
    try {
      const result=await importBackup(db,pendingImport.data,pendingImport.mode);
      $('import-preview').close();pendingImport=null;
      await changed();switchView('overview');toast('Импортировано: '+result.added+'. Пропущено: '+result.skipped+'.');
    } catch(error) {$('import-error').textContent=errorMessage(error);$('import-error').hidden=false;}
    finally {writing=false;$('confirm-import').disabled=false;}
  });
  $('persist').addEventListener('click',()=>safe(async()=>{await navigator.storage.persist();await persistState();}));
  $('install').addEventListener('click',()=>safe(async()=>{
    if(!installPrompt)return;
    await installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;$('install').hidden=true;
  }));
  channel?.addEventListener('message',()=>safe(refresh));
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')safe(refresh);});
  window.addEventListener('online',connection);window.addEventListener('offline',connection);
  window.addEventListener('hashchange',()=>switchView(location.hash.slice(1)));
}
function connection() {
  $('connection').innerHTML='<span class="status-dot"></span>'+(navigator.onLine?'На устройстве':'Без интернета');
}
async function setupOffline() {
  if(!('serviceWorker'in navigator)) {$('offline-state').textContent='Офлайн-режим недоступен в этом браузере.';return;}
  try {
    const registration=await navigator.serviceWorker.register('./sw.js',{scope:'./'});
    const updateNotice=worker=>{
      if(!worker||!navigator.serviceWorker.controller)return;
      const button=document.createElement('button');
      button.className='button secondary full';button.textContent='Обновить приложение';
      button.addEventListener('click',()=>{
        if($('editor').open||$('import-preview').open)return toast('Сначала закройте форму.');
        worker.postMessage('ACTIVATE_UPDATE');
      });
      if(!$('update-app')){button.id='update-app';$('offline-state').after(button);}
    };
    updateNotice(registration.waiting);
    registration.addEventListener('updatefound',()=>{
      const worker=registration.installing;
      worker?.addEventListener('statechange',()=>{if(worker.state==='installed')updateNotice(registration.waiting);});
    });
    let initialController=Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener('controllerchange',()=>{
      if(initialController)location.reload();
      initialController=true;
    });
    await navigator.serviceWorker.ready;
    $('offline-state').textContent='Приложение готово к работе без интернета.';
  } catch {$('offline-state').textContent='Офлайн-режим не подготовлен. Откройте приложение по HTTPS и проверьте интернет.';}
}
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;$('install').hidden=false;});
window.addEventListener('appinstalled',()=>{$('install').hidden=true;installPrompt=null;safe(persistState);});
try {
  db=await openLedger();wire();await refresh();$('boot').hidden=true;connection();
  switchView(location.hash.slice(1)||'overview');
  safe(persistState);setupOffline();
} catch(error) {
  $('boot').hidden=true;$('fatal').hidden=false;
  $('fatal').textContent='Хранилище недоступно. Расходы не будут сохраняться. Откройте приложение в обычном режиме Chrome, разрешите хранение данных и перезагрузите страницу. '+errorMessage(error);
}
