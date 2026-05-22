import 'dotenv/config'
import { verifyEmailConfig, sendMail } from './lib/email.js'

const to = process.argv[2]
if (!to) {
  console.error('Usage: node test-mail.js <recipient@example.com>')
  process.exit(1)
}

console.log('SMTP host :', process.env.SMTP_HOST)
console.log('SMTP port :', process.env.SMTP_PORT)
console.log('SMTP user :', process.env.NODE_MAILER_USER)
console.log('Recipient :', to)
console.log()

const ok = await verifyEmailConfig()
if (!ok) {
  console.error('SMTP verify failed — check the error above (auth / host / port).')
  process.exit(2)
}
console.log('SMTP verify OK — sending test message…')

await sendMail({
  to,
  subject: 'Finmax Services — SMTP test',
  text: `If you can read this, SMTP is working. Sent at ${new Date().toISOString()}`,
  html: `<p>If you can read this, SMTP is working.</p><p>Sent at <code>${new Date().toISOString()}</code></p>`,
})

console.log('Done. Check the recipient inbox (and spam folder).')
process.exit(0)
