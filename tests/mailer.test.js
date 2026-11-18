'use strict';
const mailer = require('../src/services/mailer');

describe('mailer', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; mailer._setTransportForTests(null); });

  it('skips (without throwing) when SMTP is not configured', async () => {
    delete process.env.SMTP_HOST;
    await expect(mailer.sendMail({ to: 'a@b.c', subject: 'x' })).resolves.toEqual({ sent: false, reason: 'not configured' });
  });

  it('drops blank recipients', async () => {
    process.env.SMTP_HOST = 'fake';
    await expect(mailer.sendMail({ to: [null, ''], subject: 'x' })).resolves.toEqual({ sent: false, reason: 'no recipients' });
  });

  it('sends escaped HTML to one recipient, BCCs several', async () => {
    process.env.SMTP_HOST = 'fake'; process.env.MAIL_FROM = 'FPAM <n@x.gov>';
    const sent = [];
    mailer._setTransportForTests({ sendMail: async m => sent.push(m) });
    await expect(mailer.sendMail({ to: 'a@b.c', subject: 'S', heading: '<b>', lines: ['<script>'] })).resolves.toEqual({ sent: true });
    expect(sent[0].to).toBe('a@b.c');
    expect(sent[0].html).toContain('&lt;script&gt;');
    await mailer.sendMail({ to: ['a@b.c', 'd@e.f', 'a@b.c'], subject: 'M' });
    expect(sent[1].bcc).toEqual(['a@b.c', 'd@e.f']);
  });

  it('picks the SOCKS proxy for a fixed outbound IP', () => {
    expect(mailer.smtpProxy({})).toBeNull();
    expect(mailer.smtpProxy({ FIXIE_SOCKS_HOST: 'u:p@x.usefixie.com:1080' })).toBe('socks5://u:p@x.usefixie.com:1080');
    expect(mailer.smtpProxy({ QUOTAGUARDSTATIC_URL: 'http://u:p@us-east.quotaguard.com:9293' })).toBe('socks5://u:p@us-east.quotaguard.com:1080');
    expect(mailer.smtpProxy({ SMTP_PROXY: 'socks5://a:b@h:1', FIXIE_SOCKS_HOST: 'u:p@x:1080' })).toBe('socks5://a:b@h:1');
  });

  it('reports a transport failure instead of throwing', async () => {
    process.env.SMTP_HOST = 'fake';
    mailer._setTransportForTests({ sendMail: async () => { throw new Error('down'); } });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(mailer.sendMail({ to: 'a@b.c', subject: 'f' })).resolves.toEqual({ sent: false, reason: 'down' });
    spy.mockRestore();
  });
});
