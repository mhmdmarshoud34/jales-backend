import nodemailer from "nodemailer";

const host = process.env.SMTP_HOST!;
const port = Number(process.env.SMTP_PORT || 587);
const user = process.env.SMTP_USER!;
const pass = process.env.SMTP_PASS!;
const from = process.env.MAIL_FROM || user;

export const mailer = nodemailer.createTransport({
  host,
  port,
  secure: false,
  auth: { user, pass },
});

export async function sendOtpEmail(to: string, otp: string) {
  await mailer.sendMail({
    from,
    to,
    subject: "JALES Verification Code",
    text: `Your JALES OTP is: ${otp}`,
    html: `<h2>JALES OTP</h2><p>Your verification code is:</p><h1>${otp}</h1>`
  });
}
