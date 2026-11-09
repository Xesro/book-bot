import nodemailer, { type Transporter } from "nodemailer";

export interface BookEmailAttachment {
  contentType: string;
  filename: string;
  path: string;
}

export interface Mailer {
  sendBook(recipient: string, attachment: BookEmailAttachment): Promise<void>;
  sendVerificationCode(recipient: string, code: string): Promise<void>;
}

interface SmtpConfiguration {
  from: string;
  host: string;
  pass: string;
  port: number;
  secure: boolean;
  user: string;
}

export class EmailService implements Mailer {
  private readonly from: string;
  private readonly transporter: Transporter;

  public constructor(configuration: SmtpConfiguration) {
    this.from = configuration.from;
    this.transporter = nodemailer.createTransport({
      auth: {
        pass: configuration.pass,
        user: configuration.user,
      },
      disableUrlAccess: true,
      host: configuration.host,
      maxRecipients: 1,
      port: configuration.port,
      secure: configuration.secure,
    });
  }

  public async verifyConnection(): Promise<void> {
    await this.transporter.verify();
  }

  public async sendVerificationCode(recipient: string, code: string): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      subject: "Votre code de verification Books Bot",
      text: [
        "Bonjour,",
        "",
        `Votre code de verification est : ${code}`,
        "",
        "Il est valable pendant 10 minutes. Si vous n'avez rien demande, ignorez ce message.",
      ].join("\n"),
      to: recipient,
    });
  }

  public async sendBook(recipient: string, attachment: BookEmailAttachment): Promise<void> {
    await this.transporter.sendMail({
      attachments: [attachment],
      from: this.from,
      subject: `Votre livre : ${safeHeaderValue(attachment.filename)}`,
      text: "Bonjour,\n\nVoici le livre demande depuis Telegram.\n\nBonne lecture !",
      to: recipient,
    });
  }
}

function safeHeaderValue(value: string): string {
  return value.replace(/[\r\n\0]/g, " ").slice(0, 180);
}
