// Відправка листів. Gmail через пароль застосунку (SMTP). Без налаштувань листи не відправляються,
// і сервер так і каже, а не вдає успіх.
'use strict';
const MODE = process.env.TEST_MODE === '1' ? 'test'
  : (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) ? 'gmail'
  : process.env.MAIL_MODE === 'log' ? 'log' : 'off';

let transport = null;
if (MODE === 'gmail') {
  const nodemailer = require('nodemailer');
  transport = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
}
const FROM = () => `"${process.env.MAIL_FROM_NAME || 'Мікро-консультації'}" <${process.env.GMAIL_USER || 'no-reply@localhost'}>`;
const captured = []; // лише для автоматичних тестів (TEST_MODE=1)

async function send({ to, subject, text, html }) {
  if (MODE === 'off') { const e = new Error('mail_off'); e.code = 'MAIL_OFF'; throw e; }
  if (MODE === 'test') { captured.push({ to, subject, text, at: Date.now() }); return { id: 'test' }; }
  if (MODE === 'log') {
    console.log(`\n[РЕЖИМ РОЗРОБКИ, лист НЕ відправлено]\nКому: ${to}\nТема: ${subject}\n${text}\n`);
    return { id: 'log' };
  }
  const r = await transport.sendMail({ from: FROM(), to, subject, text, html });
  return { id: r.messageId };
}
async function verify() {
  if (MODE !== 'gmail') return MODE;
  try { await transport.verify(); return 'gmail'; } catch (e) { return 'gmail_error: ' + (e.code || 'auth'); }
}

module.exports = { send, verify, MODE, captured };
