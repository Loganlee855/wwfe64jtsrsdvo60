require("dotenv").config();

const { Telegraf, Markup } = require("telegraf");
const express = require("express");
const fs = require("fs");
const axios = require("axios");
const QRCode = require("qrcode");
const crypto = require("crypto");

process.env.TZ = process.env.TZ || "Asia/Jakarta";

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
app.use(express.json());

const DB_FILE = "./db.json";
const userState = {};
const countdownTimers = {};
const TIME_ZONE = "Asia/Jakarta";
const EXPIRE_MINUTES = 5;

const HTML = {
    parse_mode: "HTML"
};

function rupiah(amount) {
    return Number(amount).toLocaleString("id-ID");
}

function formatDate(date = new Date()) {
    return new Intl.DateTimeFormat("en-GB", {
        timeZone: TIME_ZONE,
        dateStyle: "medium",
        timeStyle: "medium"
    }).format(date);
}

function esc(text) {
    return String(text ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function cleanOrderId(orderId) {
    return String(orderId || "")
        .replace(/-/g, "")
        .replace(/AUTOGOPAY/g, "");
}

function getCountdown(expiryTime) {
    const expiredAt = new Date(
        expiryTime.replace(" ", "T") + "+07:00"
    ).getTime();
    const diff = expiredAt - Date.now();
    if (diff <= 0) {
        return "00:00";
    }
    const minutes = Math.floor(diff / 1000 / 60);
    const seconds = Math.floor((diff / 1000) % 60);
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function threadOptionsFromCtx(ctx) {
    const threadId = getThreadId(ctx);
    return threadId ? { message_thread_id: threadId } : {};
}

function paymentCaption(paymentData, finalOrderId, expiredAt) {
    return `<b>━━━━〔 ⏳ EXPIRES IN • ${getCountdown(esc(paymentData.expiry_time))} 〕━━━━</b>
<b>💰 Amount:</b> IDR ${rupiah(paymentData.amount)}
<b>📍 Status:</b> <b>PENDING 🟡</b>
<b>⏰ Expired Time:</b> <code>${esc(paymentData.expiry_time)}</code>`;
}

function confirmKeyboard(amount) {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback("✅ Yes", `confirm_${amount}`),
        ],
        [
            Markup.button.callback("🔙 Back", "confirm_cancel"),
        ]
    ]);
}

function invoiceKeyboard(finalOrderId) {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback(
                "🔄 Check Status",
                `check_${finalOrderId}`
            )
        ],
        [
            Markup.button.callback(
                "❌ Cancel",
                `cancels_${finalOrderId}`
            )
        ]
    ]);
}

async function showConfirmAmount(ctx, amount) {
    const message = `<b>⚠️ Confirm Payment</b>
━━━━━━━━━━━━━━━━━━
<b>💰 Amount:</b> IDR ${rupiah(amount)}
<b>💳 Payment Method:</b> QRIS
━━━━━━━━━━━━━━━━━━
Do you want to continue and create invoice?`;

    const options = {
        ...HTML,
        ...confirmKeyboard(amount)
    };

    try {
        return await ctx.editMessageText(message, options);
    } catch {
        return await ctx.reply(message, {
            ...options,
            ...threadOptionsFromCtx(ctx)
        });
    }
}

function loadDB() {
    if (!fs.existsSync(DB_FILE)) {
        return { payments: [] };
    }

    try {
        const raw = fs.readFileSync(DB_FILE, "utf8");

        if (!raw) {
            return { payments: [] };
        }

        const db = JSON.parse(raw);

        if (!Array.isArray(db.payments)) {
            db.payments = [];
        }

        return db;
    } catch (err) {
        console.log("Failed to read database:", err.message);
        return { payments: [] };
    }
}

function saveDB(db) {
    fs.writeFileSync(
        DB_FILE,
        JSON.stringify(db, null, 2),
        "utf8"
    );
}

function getThreadId(ctx) {
    return (
        ctx.message?.message_thread_id ||
        ctx.callbackQuery?.message?.message_thread_id ||
        ctx.update?.callback_query?.message?.message_thread_id ||
        null
    );
}

function paymentSendOptions(payment) {
    return payment.thread_id
        ? { message_thread_id: payment.thread_id }
        : {};
}

function stopCountdown(orderId) {
    if (countdownTimers[orderId]) {
        clearInterval(countdownTimers[orderId]);
        delete countdownTimers[orderId];
    }
}

async function expirePayment(telegram, orderId) {
    const db = loadDB();
    const payment = db.payments.find(p => p.order_id === orderId);

    if (!payment) return;

    if (PAID_STATUS.includes(payment.status) || FAILED_STATUS.includes(payment.status)) {
        return;
    }

    payment.status = "expire";
    payment.updated_at = formatDate();
    saveDB(db);

    stopCountdown(orderId);

    await finishPayment(telegram, payment, "expire");
}

function startCountdown(telegram, paymentData, finalOrderId, sentMessage, expiredAt) {
    stopCountdown(finalOrderId);

    countdownTimers[finalOrderId] = setInterval(async () => {
        const db = loadDB();
        const payment = db.payments.find(p => p.order_id === finalOrderId);

        if (!payment) {
            stopCountdown(finalOrderId);
            return;
        }

        if (PAID_STATUS.includes(payment.status) || FAILED_STATUS.includes(payment.status)) {
            stopCountdown(finalOrderId);
            return;
        }
        const expiredAts = new Date(
            paymentData.expiry_time.replace(" ", "T") + "+07:00"
        ).getTime();

        if (Date.now() >= expiredAts) {
            await expirePayment(telegram, finalOrderId);
            return;
        }

        try {
            await telegram.editMessageCaption(
                sentMessage.chat.id,
                sentMessage.message_id,
                null,
                paymentCaption(paymentData, finalOrderId, expiredAt),
                {
                    parse_mode: "HTML",
                    ...invoiceKeyboard(finalOrderId)
                }
            );
        } catch (err) {
            console.log("Failed to update countdown:", err.message);
        }
    }, 3153);
}

const api = axios.create({
    baseURL: `${process.env.PAYMENT_API_URL}`,
    headers: {
        Authorization: `Bearer ${process.env.PAYMENT_API_KEY}`,
        "Content-Type": "application/json"
    }
});

const amountKeyboard = Markup.inlineKeyboard([
    [
        Markup.button.callback("IDR 25.000", "amount_25000"),
        Markup.button.callback("IDR 50.000", "amount_50000"),
        Markup.button.callback("IDR 100.000", "amount_100000")
    ],
    [
        Markup.button.callback("IDR 200.000", "amount_200000"),
        Markup.button.callback("IDR 300.000", "amount_300000"),
        Markup.button.callback("IDR 400.000", "amount_400000")
    ],
    [
        Markup.button.callback("IDR 500.000", "amount_500000"),
        Markup.button.callback("IDR 600.000", "amount_600000"),
        Markup.button.callback("IDR 700.000", "amount_700000")
    ],
    [
        Markup.button.callback("IDR 800.000", "amount_800000"),
        Markup.button.callback("IDR 900.000", "amount_900000"),
        Markup.button.callback("IDR 1.000.000", "amount_1000000")
    ],
    [Markup.button.callback("📝 Custom Amount", "custom_amount")]
]);

bot.start(ctx => {
    ctx.reply(
        `<b>👋 Hello!</b> Use /qris to generate a QRIS payment.`,
        HTML
    );
});

bot.command("qris", ctx => {
    ctx.reply(
        `<b>💳 QRIS Payment</b>
Please select amount below, or choose custom amount.`,
        {
            ...HTML,
            ...amountKeyboard
        }
    );
});

bot.action(/^amount_(\d+)$/, async ctx => {
    await ctx.answerCbQuery();
    await showConfirmAmount(ctx, Number(ctx.match[1]));
});

bot.action("custom_amount", async ctx => {
    await ctx.answerCbQuery();

    userState[ctx.from.id] = {
        waitingAmount: true,
        threadId: getThreadId(ctx)
    };

    await ctx.editMessageText(
        `<b>📝 Custom Amount</b>
Please enter the deposit amount. Example: <code>10000</code>`,
        {
            ...HTML,
            reply_markup: {
                inline_keyboard: []
            }
        }
    );
});

bot.action(/^confirm_(\d+)$/, async ctx => {
    await ctx.answerCbQuery();
    await createPayment(ctx, Number(ctx.match[1]));
});

bot.action("confirm_cancel", async ctx => {
    await ctx.answerCbQuery();
    delete userState[ctx.from.id];

    try {
        await ctx.editMessageText(
            `<b>💳 QRIS Payment</b>
Please select amount below, or choose custom amount.`,
            {
                ...HTML,
                ...amountKeyboard
            }
        );
    } catch {
        await ctx.reply(
            `<b>💳 QRIS Payment</b>
Please select amount below, or choose custom amount.`,
            {
                ...HTML,
                ...amountKeyboard,
                message_thread_id: getThreadId(ctx)
            }
        );
    }
});

bot.action("cancel", async ctx => {
    await ctx.answerCbQuery("cancelled");
    delete userState[ctx.from.id];

    await ctx.reply(
        `<b>❌ Payment Cancelled</b>The payment has been cancelled.`,
        HTML
    );
});

bot.action(/^cancels_(.+)$/, async ctx => {
    const orderId = ctx.match[1];
    const db = loadDB();
    const payment = db.payments.find(p => p.order_id === orderId);

    if (!payment) {
        return await ctx.answerCbQuery("Payment not found.", {
            show_alert: true
        });
    }

    const response = await api.post("/qris/cancel", {
        transaction_id: payment.transaction_id
    });

    const res = response.data;

    if (!res.success) {
        return await ctx.answerCbQuery(res.message, {
            show_alert: true
        });
    }

    payment.status = "cancel";
    payment.updated_at = formatDate();
    saveDB(db);
    stopCountdown(orderId);

    try {
        await ctx.telegram.deleteMessage(
            payment.chat_id,
            payment.message_id
        );

        await ctx.telegram.sendMessage(
            payment.chat_id,
            `<b>❌ PAYMENT CANCELLED</b>
━━━━━━━━━━━━━━━━━━
<b>💰 Amount:</b> IDR ${rupiah(payment.amount)}
<b>🆔 Transaction ID:</b> <code>${esc(payment.transaction_id)}</code>
<b>📍 Status:</b> <b>CANCELLED 🔴</b>
━━━━━━━━━━━━━━━━━━
Your payment has been cancelled.`,
            {
                ...HTML,
                ...paymentSendOptions(payment)
            }
        );
    } catch (err) {
        console.log(err.message);
    }

    await ctx.answerCbQuery(res.message, {
        show_alert: true
    });
});

bot.on("text", async ctx => {
    const state = userState[ctx.from.id];
    if (!state?.waitingAmount) return;

    const currentThreadId = getThreadId(ctx);
    if (state.threadId !== currentThreadId) return;

    const amount = Number(ctx.message.text.replace(/[^\d]/g, ""));

    if (!amount || amount < 1000) {
        return ctx.reply(
            `<b>⚠️ Invalid Amount</b>
Minimum deposit amount is <b>IDR 1,000</b>.`,
            {
                ...HTML,
                ...threadOptionsFromCtx(ctx)
            }
        );
    }

    delete userState[ctx.from.id];
    await showConfirmAmount(ctx, amount);
});

async function showLoading(ctx) {
    try {
        return await ctx.editMessageText(
            `<b>⏳ Creating Transaction</b> Please wait a moment...`,
            {
                ...HTML,
                reply_markup: {
                    inline_keyboard: []
                }
            }
        );
    } catch {
        return await ctx.reply(
            `<b>⏳ Creating Transaction</b> Please wait a moment...`,
            HTML
        );
    }
}

async function createPayment(ctx, amount) {
    const loadingMessage = await showLoading(ctx);

    try {
        const response = await api.post("/qris/generate", {
            amount: Number(amount)
        });

        const res = response.data;

        if (!res.success) {
            await ctx.telegram.editMessageText(
                loadingMessage.chat.id,
                loadingMessage.message_id,
                null,
                `<b>❌ Failed</b> Failed to create payment.`,
                HTML
            );
            return;
        }

        const paymentData = res.data;
        const finalOrderId = paymentData.order_id;
        const expiredAt = Date.now() + EXPIRE_MINUTES * 60 * 1000;
        const qrBuffer = await QRCode.toBuffer(paymentData.qr_string);

        await ctx.telegram.deleteMessage(
            loadingMessage.chat.id,
            loadingMessage.message_id
        );

        const sentMessage = await ctx.replyWithPhoto(
            { source: qrBuffer },
            {
                parse_mode: "HTML",
                caption: paymentCaption(paymentData, finalOrderId, expiredAt),
                ...invoiceKeyboard(finalOrderId)
            }
        );

        const db = loadDB();

        db.payments.push({
            transaction_id: paymentData.transaction_id,
            order_id: paymentData.order_id,
            telegram_id: ctx.from.id,
            chat_id: sentMessage.chat.id,
            message_id: sentMessage.message_id,
            thread_id: getThreadId(ctx),
            username: ctx.from.username || null,
            amount: paymentData.amount,
            status: paymentData.transaction_status,
            qr_string: paymentData.qr_string,
            qr_url: paymentData.qr_url,
            transaction_time: paymentData.transaction_time,
            expiry_time: paymentData.expiry_time,
            expired_at: expiredAt,
            created_at: formatDate()
        });

        saveDB(db);

        startCountdown(
            ctx.telegram,
            paymentData,
            finalOrderId,
            sentMessage,
            expiredAt
        );

        return sentMessage;
    } catch (err) {
        console.log(err.response?.data || err.message);

        await ctx.telegram.editMessageText(
            loadingMessage.chat.id,
            loadingMessage.message_id,
            null,
            `<b>❌ Connection Error</b> Failed to connect to payment API.`,
            HTML
        );
    }
}

const PAID_STATUS = ["paid", "success", "settlement"];
const FAILED_STATUS = ["expire", "cancel", "failed"];

async function deleteInvoiceMessage(telegram, payment) {
    try {
        await telegram.deleteMessage(
            payment.chat_id,
            payment.message_id
        );
    } catch (err) {
        console.log("Failed to delete invoice:", err.message);
    }
}

async function sendPaymentSuccessMessage(telegram, payment) {
    await telegram.sendMessage(
        payment.chat_id,
        `<b>╭━━━〔 ✅ PAYMENT SUCCESS 〕━━━╮</b>

<b>💰 Amount:</b> IDR ${rupiah(payment.amount)}
<b>🧾 Transaction ID:</b> <code>${esc(cleanOrderId(payment.order_id))}</code>
<b>📍 Status:</b> <b>PAID 🟢</b>
<b>⏰ Paid Time:</b> <code>${formatDate()}</code>
━━━━━━━━━━━━━━━━━━
Thank you. Your payment has been received successfully.`,
        {
            ...HTML,
            ...paymentSendOptions(payment)
        }
    );
}

async function sendPaymentFailedMessage(telegram, payment, status) {
    await telegram.sendMessage(
        payment.chat_id,
        `<b>❌ PAYMENT ${esc(String(status).toUpperCase())}</b>
━━━━━━━━━━━━━━━━━━
<b>💰 Amount:</b> IDR ${rupiah(payment.amount)}
<b>🧾 Transaction ID:</b> <code>${esc(cleanOrderId(payment.order_id))}</code>
<b>📍 Status:</b> <b>${esc(String(status).toUpperCase())} 🔴</b>
━━━━━━━━━━━━━━━━━━
This payment is no longer valid.`,
        {
            ...HTML,
            ...paymentSendOptions(payment)
        }
    );
}

async function finishPayment(telegram, payment, status) {
    stopCountdown(payment.order_id);

    await deleteInvoiceMessage(telegram, payment);

    if (PAID_STATUS.includes(status)) {
        return await sendPaymentSuccessMessage(telegram, payment);
    }

    if (FAILED_STATUS.includes(status)) {
        return await sendPaymentFailedMessage(telegram, payment, status);
    }
}

bot.action(/^check_(.+)$/, async ctx => {
    const orderId = ctx.match[1];

    try {
        const db = loadDB();
        const payment = db.payments.find(p => p.order_id === orderId);

        if (!payment) {
            return await ctx.answerCbQuery("Payment not found.", {
                show_alert: true
            });
        }

        if (payment.expired_at && Date.now() >= payment.expired_at) {
            payment.status = "expire";
            payment.updated_at = formatDate();
            saveDB(db);

            await ctx.answerCbQuery("Payment expired.", {
                show_alert: true
            });

            return await finishPayment(ctx.telegram, payment, "expire");
        }

        const check_status = await api.post("/qris/status", {
            transaction_id: payment.transaction_id
        });

        const api_check = check_status.data;

        if (!api_check.success) {
            return await ctx.answerCbQuery(api_check.message, {
                show_alert: true
            });
        }

        payment.status = api_check.data.transaction_status;
        payment.updated_at = formatDate();
        payment.check_response = api_check;
        saveDB(db);

        if (
            PAID_STATUS.includes(api_check.data.transaction_status) ||
            FAILED_STATUS.includes(api_check.data.transaction_status)
        ) {
            return await finishPayment(
                ctx.telegram,
                payment,
                api_check.data.transaction_status
            );
        }

        return await ctx.answerCbQuery(
            `Payment status: ${api_check.data.message}`,
            {
                show_alert: true
            }
        );
    } catch (err) {
        console.error(err.response?.data || err.message);

        return await ctx.answerCbQuery(
            "Failed to check payment status.",
            {
                show_alert: true
            }
        );
    }
});

app.post("/payment/callback", async (req, res) => {
    try {
        const signature = req.headers["x-signature"];
        const payload = JSON.stringify(req.body);
        const expectedSignature = crypto
            .createHmac("sha256", process.env.PAYMENT_API_KEY)
            .update(payload)
            .digest("hex");

        if (signature !== expectedSignature) {
            return res.status(401).json({
                success: false,
                error: "Invalid signature"
            });
        }

        const { event, transaction } = req.body;

        if (event === "verification.challenge") {
            return res.json({
                success: true
            });
        }

        if (!transaction) {
            return res.json({
                success: true
            });
        }

        const orderId = transaction.order_id;
        const status = transaction.status;
        const db = loadDB();

        const payment = db.payments.find(
            p =>
                p.order_id === orderId ||
                p.transaction_id === transaction.id
        );

        if (!payment) {
            return res.json({
                success: true
            });
        }

        payment.status = status;
        payment.updated_at = formatDate();
        saveDB(db);

        if (PAID_STATUS.includes(status) || FAILED_STATUS.includes(status)) {
            await finishPayment(
                bot.telegram,
                payment,
                status
            );
        }

        return res.json({
            success: true
        });
    } catch (err) {
        console.log("Webhook error:", err.message);

        return res.status(500).json({
            success: false,
            error: "Internal server error"
        });
    }
});

bot.launch();

function cleanupOldPayments() {

    const db = loadDB();

    const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;

    const now = Date.now();

    db.payments = db.payments.filter(payment => {

        const createdAt = new Date(
            payment.created_at
        ).getTime();

        if (isNaN(createdAt)) {
            return false;
        }

        return (now - createdAt) < TWO_DAYS;
    });

    saveDB(db);

    console.log(
        `[CLEANUP] Old payments cleaned at ${formatDate()}`
    );
}


setInterval(() => {
    cleanupOldPayments();
}, 60 * 60 * 1000);

cleanupOldPayments();

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
});
