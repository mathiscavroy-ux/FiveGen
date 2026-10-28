// Transactional e-mail. Without SMTP settings (local tests, demo) messages are only
// logged, so every flow stays usable.
import nodemailer from "nodemailer";
import { config } from "./config.js";

export const mailEnabled = Boolean(config.mail.host);

// SMTP_HOST=log: behave as if e-mail worked (address checks on) but only log the
// messages. Used for tests and for trying the flows before SMTP is set up.
const transport = mailEnabled && config.mail.host !== "log"
  ? nodemailer.createTransport({
      host: config.mail.host,
      port: config.mail.port,
      secure: config.mail.secure,
      auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined,
      // never let a message pull local files or remote URLs into its body
      disableFileAccess: true,
      disableUrlAccess: true,
    })
  : null;

// Last messages, kept for the tests and the demo.
export const outbox = [];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function layout(title, intro, button, link, outro) {
  return `<!doctype html><html lang="fr"><body style="margin:0;background:#0b0d12;font-family:Arial,sans-serif;color:#eceef3">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table width="100%" style="max-width:520px;background:#11141b;border:1px solid #23262f;border-radius:12px" cellpadding="0" cellspacing="0"><tr><td style="padding:28px">
<div style="font-weight:700;font-size:18px;color:#ff7a1a;margin-bottom:18px">FiveGen</div>
<h1 style="font-size:20px;margin:0 0 12px">${esc(title)}</h1>
<p style="line-height:1.55;color:#b4b9c6;margin:0 0 22px">${esc(intro)}</p>
<a href="${esc(link)}" style="display:inline-block;background:#ff6a1a;color:#141414;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:8px">${esc(button)}</a>
<p style="line-height:1.5;color:#7e8496;font-size:13px;margin:22px 0 0">${esc(outro)}<br>Lien : <span style="word-break:break-all">${esc(link)}</span></p>
</td></tr></table></td></tr></table></body></html>`;
}

async function send({ to, subject, text, html }) {
  outbox.push({ to, subject, text });
  if (outbox.length > 50) outbox.shift();
  if (!transport) {
    console.log(`[fivegen] e-mail (SMTP non configuré) à ${to} : ${subject}\n${text}`);
    return;
  }
  await transport.sendMail({ from: `FiveGen <${config.mail.from}>`, to, subject, text, html });
}

export function sendPasswordReset(to, link) {
  const intro = "Tu as demandé à changer le mot de passe de ton compte FiveGen. Le lien est valable 1 heure et ne fonctionne qu'une fois.";
  const outro = "Si ce n'est pas toi, ignore cet e-mail : ton mot de passe actuel reste valable.";
  return send({
    to,
    subject: "Réinitialiser ton mot de passe FiveGen",
    text: `${intro}\n\n${link}\n\n${outro}`,
    html: layout("Nouveau mot de passe", intro, "Choisir un nouveau mot de passe", link, outro),
  });
}

export function sendVerification(to, link, freeCredits) {
  const intro = freeCredits
    ? `Confirme ton adresse e-mail pour activer ton compte FiveGen et recevoir tes ${freeCredits} crédits offerts.`
    : "Confirme ton adresse e-mail pour sécuriser ton compte FiveGen.";
  const outro = "Le lien est valable 48 heures. Si tu n'as pas créé de compte, ignore cet e-mail.";
  return send({
    to,
    subject: "Confirme ton adresse e-mail FiveGen",
    text: `${intro}\n\n${link}\n\n${outro}`,
    html: layout("Bienvenue sur FiveGen", intro, "Confirmer mon adresse", link, outro),
  });
}
