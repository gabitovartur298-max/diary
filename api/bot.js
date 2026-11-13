export const config = {
    api: {
        bodyParser: {
            sizeLimit: '10mb'
        }
    }
};

export default async function handler(req, res) {
    const BOT_TOKEN = process.env.BOT_TOKEN;

    if (!BOT_TOKEN) {
        return res.status(500).json({
            ok: false,
            error: 'Не задана переменная BOT_TOKEN в настройках Vercel (Settings -> Environment Variables)'
        });
    }

    const tgApiBase = `https://api.telegram.org/bot${BOT_TOKEN}`;

    // 1. Быстрая привязка вебхука через браузер: https://ваш-сайт.vercel.app/api/bot?setup=1
    if (req.method === 'GET') {
        if (req.query.setup === '1') {
            const host = req.headers['x-forwarded-host'] || req.headers.host;
            const webhookUrl = `https://${host}/api/bot`;
            const tgRes = await fetch(`${tgApiBase}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
            const data = await tgRes.json();
            return res.status(200).json({
                message: data.ok
                    ? '✅ Вебхук успешно подключён! Оплата Звёздами и отправка PDF в чат работают.'
                    : '❌ Ошибка подключения вебхука',
                webhookUrl,
                telegramResponse: data
            });
        }
        return res.status(200).json({ status: 'Bot API endpoint is running' });
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const body = req.body || {};

    try {
        // 2. Автоматическое подтверждение оплаты Telegram Stars (pre_checkout_query)
        if (body.pre_checkout_query) {
            await fetch(`${tgApiBase}/answerPreCheckoutQuery`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    pre_checkout_query_id: body.pre_checkout_query.id,
                    ok: true
                })
            });
            return res.status(200).json({ ok: true });
        }

        // 3. Отправка PDF-отчёта пользователю прямо в чат с ботом
        if (body.action === 'send_pdf' && body.chatId && body.pdfBase64) {
            const cleanBase64 = body.pdfBase64.replace(/^data:application\/pdf;base64,/, '');
            const pdfBuffer = Buffer.from(cleanBase64, 'base64');
            const fileName = body.fileName || 'Symptom_Diary_Report.pdf';

            const formData = new FormData();
            formData.append('chat_id', String(body.chatId));
            formData.append(
                'caption',
                body.caption || '📋 Ваш клинический PDF-отчёт из «Дневника симптомов»'
            );
            const blob = new Blob([pdfBuffer], { type: 'application/pdf' });
            formData.append('document', blob, fileName);

            const sendRes = await fetch(`${tgApiBase}/sendDocument`, {
                method: 'POST',
                body: formData
            });
            const sendData = await sendRes.json();

            if (!sendData.ok) {
                return res.status(400).json({ ok: false, error: sendData.description });
            }
            return res.status(200).json({ ok: true });
        }

        return res.status(200).json({ ok: true });
    } catch (err) {
        console.error('Bot handler error:', err);
        return res.status(500).json({ ok: false, error: err.message });
    }
}
