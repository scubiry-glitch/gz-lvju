/* Customer acceptance uses the server's order ownership and contract eligibility. */
(function () {
  'use strict';
  const query = new URLSearchParams(location.search);
  const orderId = query.get('order_ref') || query.get('oid') || query.get('order') || query.get('id');
  if (!orderId) return;
  const endpoint = '/api/settlement/v1/me/service-orders/' + encodeURIComponent(orderId) + '/acceptance';
  const holder = document.createElement('section'); holder.id = 'settlement-service-acceptance'; holder.className = 'info'; holder.hidden = true; holder.style.cssText = 'margin:13px 16px 0;padding:16px;border:1px solid #dce6e5;border-radius:14px;background:#fff;font-family:inherit;';
  const title = document.createElement('h2'); title.textContent = '服务验收'; title.style.cssText = 'font-size:15px;margin:0 0 10px;color:#183b35';
  const message = document.createElement('p'); message.setAttribute('role', 'status'); message.style.cssText = 'font-size:12px;line-height:1.7;margin:0 0 12px;color:#657773';
  const button = document.createElement('button'); button.type = 'button'; button.textContent = '确认服务完成'; button.style.cssText = 'border:0;border-radius:8px;padding:10px 18px;background:#0f766e;color:#fff;font:inherit;font-size:13px;cursor:pointer';
  const refresh = document.createElement('button'); refresh.type = 'button'; refresh.textContent = '刷新验收状态'; refresh.style.cssText = 'border:0;padding:10px;background:transparent;color:#0f766e;font:inherit;font-size:12px;cursor:pointer';
  holder.append(title, message, button, refresh);
  (document.querySelector('.scr') || document.body).append(holder);
  const keys = new Map(); let busy = false;
  function headers(key) { const h = {}; const token = window.BZF_CONSOLE?.token(); if (token) h.Authorization = 'Bearer ' + token; if (key) { h['Content-Type'] = 'application/json'; h['Idempotency-Key'] = key; } return h; }
  async function request(body) {
    const serialized = body === undefined ? '' : JSON.stringify(body);
    if (body !== undefined && !keys.has(serialized)) keys.set(serialized, crypto.randomUUID());
    const response = await fetch(endpoint, { method:body === undefined ? 'GET' : 'POST', headers:headers(keys.get(serialized)), credentials:'same-origin', body:body === undefined ? undefined : serialized });
    const result = await response.json(); if (!response.ok || result.error) { const e = new Error(result.error?.message || result.error || '暂时无法读取验收进度'); e.status = response.status; throw e; }
    return result.data || result;
  }
  async function load() {
    if (busy) return; busy = true; refresh.disabled = true;
    try { const result = await request(); holder.hidden = false; button.hidden = !result.eligible || result.confirmed === true; message.textContent = result.confirmed ? '您已确认本次服务完成。结算将按商户约定继续处理。' : result.reason || (result.eligible ? '请核对本次服务是否完成。验收确认与星级评价分别记录。' : '本订单暂未满足验收条件。'); }
    catch (e) { if ([401,403,404].includes(e.status)) holder.hidden = true; else { holder.hidden = false; button.hidden = true; message.textContent = '暂未取得验收状态，请稍后刷新。'; } }
    finally { busy = false; refresh.disabled = false; }
  }
  button.addEventListener('click', () => {
    const dialog = document.createElement('dialog'); dialog.style.cssText = 'width:min(420px,calc(100vw - 32px));padding:22px;border:1px solid #dce6e5;border-radius:14px;color:#183b35;font-family:inherit;';
    dialog.innerHTML = '<form><h2 style="font-size:18px;margin:0 0 12px">确认服务完成</h2><p style="font-size:13px;line-height:1.8">请确认商户已按约定完成本次服务。确认后记录验收时间，并按合同推进结算。</p><label style="display:block;font-size:13px;line-height:1.7;margin:14px 0"><input type="checkbox" name="accepted" required> 我已核对并确认本次服务完成</label><label style="font-size:12px">验收备注（选填）<textarea name="note" maxlength="1000" style="display:block;width:100%;box-sizing:border-box;min-height:70px;margin:8px 0;border:1px solid #cddad9;border-radius:7px;padding:8px;font:inherit"></textarea></label><p data-error role="alert" style="font-size:12px;color:#b42318"></p><div style="display:flex;justify-content:flex-end;gap:10px"><button type="button" data-close style="padding:9px 14px;border:1px solid #dce6e5;border-radius:7px;background:#fff">暂不确认</button><button type="submit" style="padding:9px 14px;border:0;border-radius:7px;background:#0f766e;color:#fff">确认验收</button></div></form>';
    document.body.append(dialog); dialog.showModal(); dialog.addEventListener('close', () => dialog.remove()); dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
    dialog.querySelector('form').addEventListener('submit', async e => { e.preventDefault(); const submit = dialog.querySelector('[type=submit]'); if (submit.disabled) return; submit.disabled = true; dialog.querySelector('[data-error]').textContent = ''; try { await request({ note:dialog.querySelector('[name=note]').value.trim() }); dialog.close(); await load(); } catch (e) { dialog.querySelector('[data-error]').textContent = e.message || '请求暂未确认，请保留当前页面后重试。'; } finally { if (submit.isConnected) submit.disabled = false; } });
  });
  refresh.addEventListener('click', load);
  window.addEventListener('pageshow', load);
  window.addEventListener('beike-login', load);
  load();
})();
