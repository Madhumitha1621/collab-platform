import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { appConfig } from '../config';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * Sends notification email. With SMTP_URL set it delivers through SMTP; otherwise (local
 * development) messages are written to the log so links can be opened by hand. Delivery is
 * best-effort: a failed email never fails the change that triggered it.
 */
@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private readonly config = appConfig().mail;
  private readonly transport: Transporter | null = this.config.smtpUrl ? nodemailer.createTransport(this.config.smtpUrl) : null;
  /** Last messages sent, newest last. Lets tests and local tooling inspect mail without SMTP. */
  readonly outbox: MailMessage[] = [];

  async send(message: MailMessage): Promise<boolean> {
    this.outbox.push(message);
    if (this.outbox.length > 50) this.outbox.shift();
    if (!this.transport) {
      if (process.env.NODE_ENV !== 'production') {
        this.logger.log(`[dev mail] to=${message.to} subject="${message.subject}"\n${message.text}`);
      }
      return false;
    }
    try {
      await this.transport.sendMail({ from: this.config.from, ...message });
      return true;
    } catch (err) {
      this.logger.error(`mail delivery failed subject="${message.subject}": ${err.message}`);
      return false;
    }
  }
}
