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

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const GRAD = "background-color:#ff6a1a;background-image:linear-gradient(135deg,#ff9a4d 0%,#ff6a1a 45%,#ff3d2e 100%)";

// Same look as the site (dark surfaces, orange gradient). Tables and inline styles only:
// mail clients drop <style> blocks, flexbox and the <body> background (hence bgcolor).
function layout({ preheader, badge, title, intro, button, link, outro }) {
  const site = config.publicUrl || new URL(link).origin;
  const support = config.supportUrl
    ? ` &nbsp;·&nbsp; <a href="${esc(config.supportUrl)}" style="color:#7e8496;text-decoration:underline">Support</a>`
    : "";
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#08090c">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#08090c" style="background:#08090c"><tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="padding:0 4px 22px">
  <a href="${esc(site)}" style="text-decoration:none"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
    <td width="36" height="36" align="center" valign="middle" style="${GRAD};border-radius:10px;color:#160b04;font:800 17px ${FONT}">F</td>
    <td style="padding-left:11px;color:#ffffff;font:700 19px ${FONT};letter-spacing:-0.2px">FiveGen</td>
  </tr></table></a>
</td></tr>
<tr><td bgcolor="#111319" style="background:#111319;border:1px solid #1e222c;border-radius:16px;overflow:hidden">
  <div style="height:4px;line-height:4px;font-size:0;${GRAD}">&nbsp;</div>
  <div style="padding:36px 36px 32px;font-family:${FONT}">
    ${badge ? `<div style="display:inline-block;background:#2a1608;border:1px solid #4a2410;color:#ffb37a;font:600 12px ${FONT};padding:5px 11px;border-radius:999px;margin:0 0 16px">${esc(badge)}</div>` : ""}
    <h1 style="margin:0 0 12px;color:#ffffff;font:700 24px/1.25 ${FONT};letter-spacing:-0.3px">${esc(title)}</h1>
    <p style="margin:0 0 28px;color:#b4b9c6;font:15px/1.65 ${FONT}">${esc(intro)}</p>
    <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="${GRAD};border-radius:10px">
      <a href="${esc(link)}" style="display:inline-block;padding:14px 28px;color:#160b04;font:700 15px ${FONT};text-decoration:none;border-radius:10px">${esc(button)} &rarr;</a>
    </td></tr></table>
    <div style="margin:28px 0 0;padding:14px 16px;background:#0c0e13;border:1px solid #1e222c;border-radius:10px">
      <div style="color:#7e8496;font:12px/1.5 ${FONT};margin:0 0 6px">Le bouton ne marche pas ? Copie ce lien dans ton navigateur :</div>
      <a href="${esc(link)}" style="color:#ffb37a;font:12px/1.5 Consolas,Menlo,monospace;word-break:break-all;text-decoration:none">${esc(link)}</a>
    </div>
    <p style="margin:24px 0 0;color:#7e8496;font:13px/1.6 ${FONT}">${esc(outro)}</p>
  </div>
</td></tr>
<tr><td align="center" style="padding:26px 12px 0;color:#4a5063;font:12px/1.7 ${FONT}">
  FiveGen · Scripts FiveM QBCore, Qbox et ESX prêts en quelques minutes<br>
  <a href="${esc(site)}" style="color:#7e8496;text-decoration:underline">${esc(site.replace(/^https?:\/\//, ""))}</a>${support}<br>
  E-mail automatique, merci de ne pas y répondre.
</td></tr>
</table></td></tr></table></body></html>`;
}

async function send({ to, subject, text, html }) {
  outbox.push({ to, subject, text, html });
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
    html: layout({
      preheader: "Ton lien pour choisir un nouveau mot de passe, valable 1 heure.",
      title: "Nouveau mot de passe",
      intro,
      button: "Choisir un nouveau mot de passe",
      link,
      outro,
    }),
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
    html: layout({
      preheader: freeCredits ? `Confirme ton adresse et reçois tes ${freeCredits} crédits offerts.` : "Confirme ton adresse e-mail.",
      badge: freeCredits ? `🎁 ${freeCredits} crédits offerts` : "",
      title: "Bienvenue sur FiveGen",
      intro,
      button: "Confirmer mon adresse",
      link,
      outro,
    }),
  });
}
