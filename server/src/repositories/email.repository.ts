import { Injectable } from '@nestjs/common';
import { render } from '@react-email/render';
import { createTransport } from 'nodemailer';
import React from 'react';
import { AlbumInviteEmail } from 'src/emails/album-invite.email';
import { AlbumUpdateEmail } from 'src/emails/album-update.email';
import { TestEmail } from 'src/emails/test.email';
import { WelcomeEmail } from 'src/emails/welcome.email';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { EmailImageAttachment } from 'src/types';

export type SendEmailOptions = {
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  imageAttachments?: EmailImageAttachment[];
  smtp: SmtpOptions;
};

export type SmtpOptions = {
  host: string;
  port?: number;
  secure?: boolean;
  username?: string;
  password?: string;
  ignoreCert?: boolean;
};

export enum EmailTemplate {
  TEST_EMAIL = 'test',

  // AUTH
  WELCOME = 'welcome',
  RESET_PASSWORD = 'reset-password',

  // ALBUM
  ALBUM_INVITE = 'album-invite',
  ALBUM_UPDATE = 'album-update',
}

interface BaseEmailProps {
  baseUrl: string;
  customTemplate?: string;
}

export interface TestEmailProps extends BaseEmailProps {
  displayName: string;
}

export interface WelcomeEmailProps extends BaseEmailProps {
  displayName: string;
  username: string;
  password?: string;
}

export interface AlbumInviteEmailProps extends BaseEmailProps {
  albumName: string;
  albumId: string;
  senderName: string;
  recipientName: string;
  cid?: string;
}

export interface AlbumUpdateEmailProps extends BaseEmailProps {
  albumName: string;
  albumId: string;
  recipientName: string;
  cid?: string;
}

export type EmailRenderRequest =
  | {
      template: EmailTemplate.TEST_EMAIL;
      data: TestEmailProps;
      customTemplate: string;
    }
  | {
      template: EmailTemplate.WELCOME;
      data: WelcomeEmailProps;
      customTemplate: string;
    }
  | {
      template: EmailTemplate.ALBUM_INVITE;
      data: AlbumInviteEmailProps;
      customTemplate: string;
    }
  | {
      template: EmailTemplate.ALBUM_UPDATE;
      data: AlbumUpdateEmailProps;
      customTemplate: string;
    };

export type SendEmailResponse = {
  messageId: string;
  response: any;
};

@Injectable()
export class EmailRepository {
  constructor(private logger: LoggingRepository) {
    this.logger.setContext(EmailRepository.name);
  }

  async verifySmtp(options: SmtpOptions): Promise<true> {
    const safeOpts = {
      host: options.host,
      port: options.port,
      secure: options.secure,
      username: options.username ?? '(none)',
      password: options.password ? '********' : '(none)',
      ignoreCert: options.ignoreCert,
    };
    this.logger.log(`Verifying SMTP connection to ${options.host}:${options.port} (secure=${options.secure})`);
    this.logger.debug(`SMTP options: ${JSON.stringify(safeOpts)}`);

    const transport = this.createTransport(options);
    try {
      await transport.verify();
      this.logger.log(`SMTP verification successful for ${options.host}:${options.port}`);
      return true;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const details = [
        err.message,
        (err as NodeJS.ErrnoException).code && `code=${(err as NodeJS.ErrnoException).code}`,
        (err as NodeJS.ErrnoException).errno !== undefined && `errno=${(err as NodeJS.ErrnoException).errno}`,
      ]
        .filter(Boolean)
        .join(', ');
      this.logger.error(`SMTP verification failed for ${options.host}:${options.port}: ${details}`, err.stack);
      throw error;
    } finally {
      transport.close();
    }
  }

  async renderEmail(request: EmailRenderRequest): Promise<{ html: string; text: string }> {
    const component = this.render(request);
    const html = await render(component, { pretty: false });
    const text = await render(component, { plainText: true });
    return { html, text };
  }

  sendEmail({ to, from, subject, html, text, smtp, imageAttachments }: SendEmailOptions): Promise<SendEmailResponse> {
    this.logger.debug(`Sending email to ${to} with subject: ${subject}`);
    const transport = this.createTransport(smtp);

    const attachments = imageAttachments?.map((attachment) => ({
      filename: attachment.filename,
      path: attachment.path,
      cid: attachment.cid,
    }));

    try {
      return transport.sendMail({ to, from, subject, html, text, attachments });
    } finally {
      transport.close();
    }
  }

  private render({ template, data, customTemplate }: EmailRenderRequest): React.FunctionComponentElement<any> {
    switch (template) {
      case EmailTemplate.TEST_EMAIL: {
        return React.createElement(TestEmail, { ...data, customTemplate });
      }

      case EmailTemplate.WELCOME: {
        return React.createElement(WelcomeEmail, { ...data, customTemplate });
      }

      case EmailTemplate.ALBUM_INVITE: {
        return React.createElement(AlbumInviteEmail, { ...data, customTemplate });
      }

      case EmailTemplate.ALBUM_UPDATE: {
        return React.createElement(AlbumUpdateEmail, { ...data, customTemplate });
      }
    }
  }

  private createTransport(options: SmtpOptions) {
    const port = options.port ?? (options.secure ? 465 : 587);
    const secure = options.secure ?? port === 465;
    return createTransport({
      host: options.host,
      port,
      secure,
      requireTLS: !secure && port === 587,
      tls: { rejectUnauthorized: !options.ignoreCert },
      auth:
        options.username || options.password
          ? {
              user: options.username,
              pass: options.password,
            }
          : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
      dnsTimeout: 10_000,
    });
  }
}
