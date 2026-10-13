/**
 * Translations as an injectable service, for server-side rendering of emails, push
 * and SMS.
 *
 *   constructor(@InjectI18n() private readonly i18n: I18n) {}
 *   const t = await this.i18n.getTranslator(recipient.locale, recipient.timeZone);
 *
 * Seam: messages come from the bundled catalog in packages/i18n today. To edit copy
 * without a deploy, register `I18nModule.forRoot({ source: databaseMessageSource })`
 * (a MessageSource over a table, cached in Redis) and call `i18n.invalidate(locale)`
 * when copy changes (e.g. from a Redis pub/sub message so every replica drops its
 * cache). Nothing that uses the translator changes.
 */
import { type DynamicModule, Global, Inject, Module } from "@nestjs/common";
import { bundledMessages, createI18n, type I18n, type MessageSource } from "@repo/i18n";

export const I18N = Symbol("I18N");
export const InjectI18n = () => Inject(I18N);
export type { I18n };

@Global()
@Module({})
export class I18nModule {
  static forRoot(options: { source?: MessageSource } = {}): DynamicModule {
    return {
      module: I18nModule,
      providers: [
        { provide: I18N, useFactory: () => createI18n(options.source ?? bundledMessages) },
      ],
      exports: [I18N],
    };
  }
}
