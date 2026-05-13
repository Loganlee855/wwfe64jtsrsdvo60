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

const OWNER_ID = ["7633035445"];

function isOwner(ctx) {
    return OWNER_ID.includes(String(ctx.from.id));
}

function loadBanks() {
    const db = loadDB();

    if (!db.banks) {
        db.banks = [];
        saveDB(db);
    }

    return db.banks;
}

function saveBanks(banks) {
    const db = loadDB();
    db.banks = banks;
    saveDB(db);
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
            {
                text: "✅ Yes",
                callback_data: `confirm_${amount}`,
                style: "success"
            },
            {
                text: "🔙 Back",
                callback_data: "confirm_cancel",
                style: "danger"
            }
        ]
    ]);
}

function invoiceKeyboard(finalOrderId) {
    return Markup.inlineKeyboard([
        [
            {
                text: "🔄 Check Status",
                callback_data: `check_${finalOrderId}`,
                style: "primary"
            }
        ],
        [
            {
                text: "🧾 View Invoice",
                url: `${process.env.PAYMENT_URL}/invoice/${finalOrderId}`,
                style: "primary"
            },
            {
                text: "❌ Cancel",
                callback_data: `cancels_${finalOrderId}`,
                style: "danger"
            }
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

        const check_status = await api.post("/qris/status", {
            transaction_id: payment.transaction_id
        });

        const api_check = check_status.data;

        if (!api_check.success && api_check.message != 'Transaction pending') {
            stopCountdown(finalOrderId);
            return;
        }

        if (PAID_STATUS.includes(api_check.data.transaction_status) || FAILED_STATUS.includes(api_check.data.transaction_status)) {
            payment.status = api_check.data.transaction_status;
            payment.updated_at = formatDate();
            payment.check_response = api_check;
            saveDB(db);
            return await finishPayment(
                telegram,
                payment,
                api_check.data.transaction_status
            );
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
    [
        {
            text: "📝 Custom Amount",
            callback_data: "custom_amount",
            style: "primary"
        }
    ]
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
        threadId: getThreadId(ctx),
        botMsgId: ctx.callbackQuery.message.message_id
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

bot.command("bank", async ctx => {
    const banks = loadBanks();
    if (!banks.length) {
        return ctx.reply(
            "❌ No bank available."
        );
    }

    let text = `<b>BANK LIST</b>\n ━━━━━━━━━━━━━━━━━━`;
    for (const bank of banks) {
        if (bank.name == 'USDT') {
            text += `
<b>Wallet:</b> ${esc(bank.name)} - ${esc(bank.holder)}
<b>Address:</b> <code>${esc(bank.number)}</code>
`;
        } else {
            text += `
<b>Bank Name:</b> ${esc(bank.name)}
<b>Account Name:</b> ${esc(bank.holder)}
<b>Account Number:</b> <code>${esc(bank.number)}</code>
`;
        }
    }

    text += `━━━━━━━━━━━━━━━━━━`

    await ctx.reply(text, {
        ...HTML,
        ...threadOptionsFromCtx(ctx)
    });
});

bot.command("addbank", async ctx => {

    if (!isOwner(ctx)) {
        return ctx.reply("❌ Owner only.");
    }

    const input = ctx.message.text.split(" ").slice(1).join(" ");

    if (!input.includes("|")) {
        return ctx.reply(
            "Format:\n/addbank BCA|123456789|Name"
        );
    }

    const [name, number, holder] = input.split("|");

    if (!name || !number || !holder) {
        return ctx.reply(
            "Format:\n/addbank BCA|123456789|Name"
        );
    }

    const banks = loadBanks();

    banks.push({
        name: name.trim(),
        number: number.trim(),
        holder: holder.trim()
    });

    saveBanks(banks);

    await ctx.reply("✅ Bank added.");
});

bot.command("delbank", async ctx => {

    if (!isOwner(ctx)) {
        return ctx.reply("❌ Owner only.");
    }

    const bankName = ctx.message.text
        .split(" ")
        .slice(1)
        .join(" ")
        .trim()
        .toUpperCase();

    if (!bankName) {
        return ctx.reply(
            "Format:\n/delbank BCA"
        );
    }

    const banks = loadBanks();

    const filtered = banks.filter(
        b => b.name.toUpperCase() !== bankName
    );

    saveBanks(filtered);

    await ctx.reply("✅ Bank deleted.");
});

bot.on("text", async ctx => {
    const state = userState[ctx.from.id];
    if (!state?.waitingAmount) return;

    const currentThreadId = getThreadId(ctx);

    if (state.threadId !== currentThreadId) return;

    await ctx.deleteMessage().catch(() => { });

    if (state.botMsgId) {
        await ctx.telegram.deleteMessage(
            ctx.chat.id,
            state.botMsgId
        ).catch(() => { });
    }

    const amount = Number(
        ctx.message.text.replace(/[^\d]/g, "")
    );

    if (!amount || amount < 1000) {
        const msg = await ctx.reply(
            `⚠️ Invalid Amount\nMinimum deposit is IDR 1,000`
        );

        setTimeout(async () => {
            await ctx.telegram.deleteMessage(
                ctx.chat.id,
                msg.message_id
            ).catch(() => { });
        }, 5000);

        return msg;
    }

    if (amount > 10000000) {
        const msg = await ctx.reply(
            `⚠️ Invalid Amount\nMaximum deposit is IDR 10,000,000`
        );

        setTimeout(async () => {
            await ctx.telegram.deleteMessage(
                ctx.chat.id,
                msg.message_id
            ).catch(() => { });
        }, 5000);

        return msg;
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
        let finalAmount = Number(amount);
        if (finalAmount >= 500000) {
            finalAmount += Math.ceil(finalAmount * 0.005);
        }

        const response = await api.post("/qris/generate", {
            amount: finalAmount
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
            original_amount: amount,
            fee_amount: finalAmount - amount,
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

        if (PAID_STATUS.includes(api_check.data.transaction_status) ||
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

app.post("/webhook/gopay", async (req, res) => {
    console.log(
        "Webhook callback:",
        JSON.stringify(req.body, null, 2)
    );

    try {
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

        if (
            PAID_STATUS.includes(status) ||
            FAILED_STATUS.includes(status)
        ) {
            try {
                await finishPayment(
                    bot.telegram,
                    payment,
                    status
                );
            } catch (finishErr) {
                console.log(
                    "Finish payment error:",
                    finishErr.message
                );
            }
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

app.get("/invoice/:orderId", (req, res) => {
    const { orderId } = req.params;

    const db = loadDB();
    const payment = db.payments.find(
        p => p.transaction_id === orderId || p.order_id === orderId
    );

    if (!payment) {
        return res.status(404).send("Payment not found");
    }

    res.send(`
<!DOCTYPE html>
<html lang="en">

<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Invoice - ${cleanOrderId(payment.transaction_id)}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
</head>

<body class="overflow-x-auto bg-slate-100">
  <div class="min-h-screen flex items-center justify-center px-4 py-10">
    <div class="w-full max-w-md bg-white rounded-3xl shadow-xl overflow-hidden">

      <div class="bg-gradient-to-r from-blue-600 to-indigo-600 px-6 py-6 text-white text-center">
        <h1 class="text-2xl font-bold">Invoice</h1>
        <p class="text-sm text-blue-100 mt-1">#${cleanOrderId(payment.order_id)}</p>
      </div>

      <div class="p-6">

        <div id="info-container" class="bg-slate-50 rounded-2xl p-4 mb-6 border border-slate-200">
          <div class="flex justify-between gap-4 mb-3">
            <span class="text-sm text-slate-500">Transaction ID</span>
            <span class="text-sm font-semibold text-slate-800 text-right break-all">${cleanOrderId(payment.order_id)}</span>
          </div>

          <div class="flex justify-between gap-4 mb-3">
            <span class="text-sm text-slate-500">Amount</span>
            <span class="text-xl font-bold text-blue-600">
              Rp ${Number(payment.amount).toLocaleString("id-ID")}
            </span>
          </div>

          <div class="flex justify-between gap-4">
            <span class="text-sm text-slate-500">Transaction Time</span>
            <span class="text-xs font-semibold text-slate-700 text-right break-all">${payment.transaction_time}</span>
          </div>
        </div>

        <div id="qrcode-container" class="flex justify-center mb-6">
          <div id="qrcode" class="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm"></div>
        </div>

        <div id="result-message" class="hidden mb-6"></div>

        <div id="timer-box" class="bg-amber-50 border border-amber-200 rounded-2xl p-4 mb-5">
          <div class="flex items-center justify-between">
            <span class="text-sm font-medium text-slate-700">Expired in</span>
            <span id="timer" class="text-xl font-bold text-amber-600">--:--</span>
          </div>

          <div class="mt-3">
            <div class="w-full bg-slate-200 rounded-full h-2">
              <div id="progress" class="bg-amber-500 h-2 rounded-full transition-all duration-1000" style="width: 100%"></div>
            </div>
          </div>
        </div>

        <div class="text-center mb-6">
          <div id="status" class="inline-flex items-center px-4 py-2 rounded-full bg-amber-100 text-amber-800 text-sm font-semibold">
            Waiting for payment
          </div>
        </div>

        <div id="button-area" class="grid grid-cols-1 gap-3">
          <button id="download-qris-btn" onclick="downloadQR()" class="w-full bg-slate-900 hover:bg-slate-800 text-white font-semibold py-3 px-4 rounded-xl transition">
            Download QRIS
          </button>
        </div>

      </div>
    </div>
  </div>

  <script>
    const qrisData = ${JSON.stringify(payment.qr_string)};
    const orderId = ${JSON.stringify(payment.order_id)};
    const cleareOrder = '${cleanOrderId(payment.order_id)}';
    const expiredAt = ${JSON.stringify(
        new Date(payment.expiry_time).toLocaleString("sv-SE", {
            timeZone: "Asia/Jakarta",
        }),
    )};
    const amount = ${JSON.stringify(Number(payment.amount))};
    const transactionId = ${JSON.stringify(payment.transaction_id)};
    let paymentStatus = ${JSON.stringify(payment.status || "pending")};
    const expiryTime = new Date(expiredAt.replace(" ", "T") + "+07:00").getTime();
    const startTime = new Date(new Date().toLocaleString("sv-SE", {
        timeZone: "Asia/Jakarta"
      }).replace(" ", "T") + "+07:00").getTime();

    const totalDuration = expiryTime - startTime;

    function isPaid(status) {
      return ["paid", "success", "settlement"].includes(String(status).toLowerCase());
    }

    function isFailed(status) {
      return ["expired", "expire", "cancel", "failed"].includes(String(status).toLowerCase());
    }


    const paymentInterval = setInterval(() => {
    if (isPaid(paymentStatus) || isFailed(paymentStatus)) {
        clearInterval(paymentInterval);
        return;
    }
    if (Date.now() >= expiryTime) {
        clearInterval(paymentInterval);
        return;
    }
    checkPaymentStatus(false);
    }, 3000);

    function hidePaymentArea() {
      document.getElementById("info-container").style.display = "none";
      document.getElementById("qrcode-container").style.display = "none";
      document.getElementById("timer-box").style.display = "none";
      document.getElementById("download-qris-btn").style.display = "none";
    }

    function setSuccessPage() {
      clearInterval(paymentInterval);
      hidePaymentArea();

      document.getElementById("status").className =
        "inline-flex items-center px-4 py-2 rounded-full bg-green-100 text-green-700 text-sm font-semibold";
      document.getElementById("status").innerHTML = "Payment Successful";

      document.getElementById("result-message").className =
        "bg-green-50 border border-green-200 rounded-3xl p-6 mb-6 text-center";

      document.getElementById("result-message").innerHTML = \`
            <div class="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-green-100">
                <svg class="h-11 w-11 text-green-600" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"></path>
                </svg>
            </div>

            <h3 class="text-2xl font-bold text-green-700 mb-2">
                Payment Successful
            </h3>

            <p class="text-sm text-green-700 mb-5">
                Your payment has been received and confirmed.
            </p>

            <div class="bg-white rounded-2xl p-4 text-left border border-green-200 space-y-3">
                <div class="flex justify-between gap-4">
                    <span class="text-sm text-slate-500">Amount</span>
                    <span class="text-sm font-bold text-green-600">
                        Rp \${Number(amount).toLocaleString("id-ID")}
                    </span>
                </div>

                <div class="flex justify-between gap-4">
                    <span class="text-sm text-slate-500">Transaction</span>
                    <span class="text-xs font-semibold text-slate-700 text-right break-all">
                        \${cleareOrder}
                    </span>
                </div>

                <div class="flex justify-between gap-4">
                    <span class="text-sm text-slate-500">Status</span>
                    <span class="text-sm font-bold text-green-600">PAID</span>
                </div>
            </div>
        \`;
    }

    function setFailedPage(statusText = "Expired") {
        clearInterval(paymentInterval);
        hidePaymentArea();

        const cleanStatus = String(statusText).toUpperCase();

        document.getElementById("status").className =
            "inline-flex items-center px-4 py-2 rounded-full bg-red-100 text-red-700 text-sm font-semibold";
        document.getElementById("status").innerHTML = "Payment " + cleanStatus;

        document.getElementById("result-message").className =
            "bg-red-50 border border-red-200 rounded-3xl p-6 mb-6 text-center";

        document.getElementById("result-message").innerHTML = \`
            <div class="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-red-100">
                <svg class="h-11 w-11 text-red-600" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"></path>
                </svg>
            </div>

            <h3 class="text-2xl font-bold text-red-700 mb-2">
                Payment \${cleanStatus}
            </h3>

            <p class="text-sm text-red-700 mb-5">
                This payment is no longer valid.
            </p>

            <div class="bg-white rounded-2xl p-4 text-left border border-red-200 space-y-3">
                <div class="flex justify-between gap-4">
                    <span class="text-sm text-slate-500">Amount</span>
                    <span class="text-sm font-bold text-red-600">
                        Rp \${Number(amount).toLocaleString("id-ID")}
                    </span>
                </div>

                <div class="flex justify-between gap-4">
                    <span class="text-sm text-slate-500">Transaction</span>
                    <span class="text-xs font-semibold text-slate-700 text-right break-all">
                        \${cleareOrder}
                    </span>
                </div>

                <div class="flex justify-between gap-4">
                    <span class="text-sm text-slate-500">Status</span>
                    <span class="text-sm font-bold text-red-600">
                        \${cleanStatus}
                    </span>
                </div>
            </div>
        \`;
    }

    function generateQR() {
        if (isPaid(paymentStatus)) {
            setSuccessPage();
            return;
        }

        if (isFailed(paymentStatus)) {
            setFailedPage(paymentStatus);
            return;
        }

        if (Date.now() >= expiryTime) {
            setFailedPage("EXPIRED");
            return;
        }

        new QRCode(document.getElementById("qrcode"), {
            text: qrisData,
            width: 256,
            height: 256,
            colorDark: "#000000",
            colorLight: "#ffffff",
            correctLevel: QRCode.CorrectLevel.H
        });
    }

    function updateTimer() {
        if (isPaid(paymentStatus) || isFailed(paymentStatus)) return;

        const now = Date.now();
        const distance = expiryTime - now;

        if (distance <= 0) {
            document.getElementById("timer").innerHTML = "EXPIRED";
            document.getElementById("progress").style.width = "0%";
            setFailedPage("EXPIRED");
            return;
        }

        const minutes = Math.floor(distance / 1000 / 60);
        const seconds = Math.floor((distance / 1000) % 60);

        document.getElementById("timer").innerHTML =
            String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0");

        const progress = Math.max(0, Math.min(100, (distance / totalDuration) * 100));
        document.getElementById("progress").style.width = progress + "%";

        setTimeout(updateTimer, 1000);
    }

    function downloadQR() {
        const qrCanvas = document.querySelector("#qrcode canvas");

        if (!qrCanvas) {
            return alert("QR Code not available");
        }

        const link = document.createElement("a");
        link.download = "QRIS-" + orderId + ".png";
        link.href = qrCanvas.toDataURL("image/png");
        link.click();
    }

    async function checkPaymentStatus(showAlert = false) {
        try {
            const response = await fetch("/api/payment/status/" + transactionId);
            const data = await response.json();

            if (!data.success) {
                if (showAlert) alert(data.message || "Failed to check payment status");
                return;
            }

            const paymentStatus = data.data.status;

            if (isPaid(paymentStatus)) {
                setSuccessPage();
                return;
            }

            if (isFailed(paymentStatus)) {
                setFailedPage(paymentStatus);
                return;
            }

            if (showAlert) {
                alert("Payment status: " + paymentStatus);
            }

        } catch (err) {
            console.error(err);

            if (showAlert) {
                alert("Failed to check payment status");
            }
        }
    }

    generateQR();
    updateTimer();
    checkPaymentStatus(false);
  </script>
</body>

</html>
`);
});

app.get("/api/payment/status/:orderId", async (req, res) => {
    const { orderId } = req.params;

    const db = loadDB();
    const payment = db.payments.find(p => p.transaction_id === orderId);

    if (!payment) {
        return res.json({
            success: false,
            message: "Payment not found"
        });
    }

    if (payment.status != 'pending') {
        return res.json({
            success: true,
            data: {
                order_id: payment.order_id,
                transaction_id: payment.transaction_id,
                status: payment.status
            }
        });
    }


    const expiredAts = new Date(
        payment.expiry_time.replace(" ", "T") + "+07:00"
    ).getTime();

    if (payment.expiry_time && Date.now() >= expiredAts) {
        payment.status = "expire";
        payment.updated_at = formatDate();
        saveDB(db);

        return res.json({
            success: true,
            data: {
                order_id: payment.order_id,
                transaction_id: payment.transaction_id,
                status: payment.status
            }
        });
    }

    const check_status = await api.post("/qris/status", {
        transaction_id: payment.transaction_id
    });

    const api_check = check_status.data;

    if (!api_check.success) {
        return res.json({
            success: true,
            data: {
                order_id: payment.order_id,
                transaction_id: payment.transaction_id,
                status: payment.status
            }
        });
    }

    payment.status = api_check.data.transaction_status;
    payment.updated_at = formatDate();
    payment.check_response = api_check;
    saveDB(db);

    return res.json({
        success: true,
        data: {
            order_id: payment.order_id,
            transaction_id: payment.transaction_id,
            status: api_check.data.transaction_status
        }
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).send(`
    <h1>Page Not Found</h1>
  `)
})

// Global error handler
app.use((err, req, res, next) => {
    console.error(err)

    res.status(err.status || 500).send(`
    <h1>Internal Server Error</h1>
  `)
})

setInterval(() => {
    cleanupOldPayments();
}, 60 * 60 * 1000);

cleanupOldPayments();

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
});
