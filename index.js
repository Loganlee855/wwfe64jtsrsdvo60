require("dotenv").config();

const { Telegraf, Markup } = require("telegraf");
const express = require("express");
const fs = require("fs");
const axios = require("axios");
const QRCode = require("qrcode");
const crypto = require("crypto");

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
app.use(express.json());

const DB_FILE = "./db.json";
const userState = {};

function loadDB() {

    if (!fs.existsSync(DB_FILE)) {
        return { payments: [] };
    }

    try {

        const raw = fs.readFileSync(
            DB_FILE,
            "utf8"
        );

        if (!raw) {
            return { payments: [] };
        }

        const db = JSON.parse(raw);

        if (!Array.isArray(db.payments)) {
            db.payments = [];
        }

        return db;

    } catch (err) {

        console.log(
            "Failed to read database:",
            err.message
        );

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

const api = axios.create({
    baseURL: `${process.env.PAYMENT_API_URL}`,
    headers: {
        Authorization: `Bearer ${process.env.PAYMENT_API_KEY}`,
        "Content-Type": "application/json"
    }
});

const amountKeyboard = Markup.inlineKeyboard([
    [
        Markup.button.callback("Rp 25.000", "amount_25000"),
        Markup.button.callback("Rp 50.000", "amount_50000")
    ],
    [
        Markup.button.callback("Rp 100.000", "amount_100000"),
        Markup.button.callback("Rp 200.000", "amount_200000")
    ],
    [Markup.button.callback("📝 Custom Amount", "custom_amount")]
]);

bot.start(ctx => {
    ctx.reply("Hello!");
});

bot.command("pay", ctx => {
    ctx.reply(
        "Please select the deposit amount or enter another amount.",
        amountKeyboard
    );
});

bot.action(/^amount_(\d+)$/, async ctx => {
    await ctx.answerCbQuery();
    await createPayment(ctx, Number(ctx.match[1]));
});

bot.action("custom_amount", async ctx => {
    await ctx.answerCbQuery();
    userState[ctx.from.id] = { waitingAmount: true };

    await ctx.editMessageText(
        "Enter the deposit amount, eg: 10000",
        {
            reply_markup: {
                inline_keyboard: []
            }
        }
    );
});

bot.action("cancel", async ctx => {
    await ctx.answerCbQuery("cancelled");
    delete userState[ctx.from.id];
    await ctx.reply("❌ Payment cancelled.");
});

bot.action(/^cancels_(.+)$/, async ctx => {
    const orderId = ctx.match[1];
    const db = loadDB();
    const payment = db.payments.find(
        p => p.order_id === orderId
    );

    if (!payment) {
        return await ctx.answerCbQuery(
            "Payment not found.",
            {
                show_alert: true
            }
        );
    }

    payment.status = "cancel";
    payment.updated_at = new Date().toISOString();
    saveDB(db);

    try {
        await ctx.telegram.deleteMessage(
            payment.chat_id,
            payment.message_id
        );

        await ctx.telegram.sendMessage(
            payment.chat_id,
            `❌ PAYMENT CANCELLED
━━━━━━━━━━━━━━━━━━
💰 Amount: Rp ${payment.amount.toLocaleString("id-ID")}
🆔 Transaction ID: ${payment.transaction_id}
📍 Status: CANCELLED 🔴
━━━━━━━━━━━━━━━━━━`
        );

    } catch (err) {
        console.log(err.message);
    }

    await ctx.answerCbQuery(
        "Payment cancelled."
    );
});

bot.on("text", async ctx => {
    if (!userState[ctx.from.id]?.waitingAmount) return;

    const amount = Number(ctx.message.text.replace(/[^\d]/g, ""));

    if (!amount || amount < 1000) {
        return ctx.reply("Invalid amount. Minimum Rp 1,000.");
    }

    delete userState[ctx.from.id];
    await createPayment(ctx, amount);
});

async function showLoading(ctx) {
    try {
        return await ctx.editMessageText(
            "⏳ Creating transaction, please wait...",
            {
                reply_markup: {
                    inline_keyboard: []
                }
            }
        );
    } catch {
        return await ctx.reply(
            "⏳ Creating transaction, please wait..."
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
                "❌ Failed to make payment."
            );
            return;
        }

        const paymentData = res.data;
        const finalOrderId = paymentData.order_id;

        const qrBuffer = await QRCode.toBuffer(paymentData.qr_string);

        await ctx.telegram.deleteMessage(
            loadingMessage.chat.id,
            loadingMessage.message_id
        );

        const sentMessage = await ctx.replyWithPhoto(
            { source: qrBuffer },
            {
                caption:
                    `╭━━━〔 PAYMENT INVOICE 〕━━━╮
💰 Amount: Rp ${paymentData.amount.toLocaleString("id-ID")}
📍 Status: PENDING 🟡
⏰ Expired Time: ${paymentData.expiry_time}
━━━━━━━━━━━━━━━━━━
Please complete the payment
before the QRIS expires.

The transaction will automatically
expire in 5 minutes.
━━━━━━━━━━━━━━━━━━`,
                ...Markup.inlineKeyboard([
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
                ])
            }
        );

        const db = loadDB();

        db.payments.push({
            transaction_id: paymentData.transaction_id,
            order_id: paymentData.order_id,
            telegram_id: ctx.from.id,
            chat_id: sentMessage.chat.id,
            message_id: sentMessage.message_id,
            username: ctx.from.username || null,
            amount: paymentData.amount,
            status: paymentData.transaction_status,
            qr_string: paymentData.qr_string,
            qr_url: paymentData.qr_url,
            transaction_time: paymentData.transaction_time,
            expiry_time: paymentData.expiry_time,
            created_at: new Date().toISOString()
        });

        saveDB(db);

        return sentMessage;

    } catch (err) {
        console.log(err.response?.data || err.message);

        await ctx.telegram.editMessageText(
            loadingMessage.chat.id,
            loadingMessage.message_id,
            null,
            "❌ Failed to connect to payment API."
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
        `╭━━━〔 PAYMENT SUCCESS 〕━━━╮
✅ Payment Confirmed
💰 Amount: Rp ${Number(payment.amount).toLocaleString("id-ID")}

🧾 Transaction ID: ${payment.transaction_id}

📍 Status: PAID 🟢

⏰ Paid Time
${new Date().toLocaleString("id-ID")}
━━━━━━━━━━━━━━━━━━
Thank you for your payment.`
    );
}

async function sendPaymentFailedMessage(telegram, payment, status) {
    await telegram.sendMessage(
        payment.chat_id,
        `❌ PAYMENT FAILED / EXPIRED
━━━━━━━━━━━━━━━━━━
💰 Amount: Rp ${Number(payment.amount).toLocaleString("id-ID")}

🧾 Transaction ID: ${payment.transaction_id}

📍 Status: ${String(status).toUpperCase()} 🔴
━━━━━━━━━━━━━━━━━━
This payment is no longer valid.`
    );
}

async function finishPayment(telegram, payment, status) {
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
        await ctx.answerCbQuery("Checking payment status...");

        const db = loadDB();
        const payment = db.payments.find(p => p.order_id === orderId);

        if (!payment) {
            return await ctx.answerCbQuery("Payment not found.", {
                show_alert: true
            });
        }

        const { data } = await api.post("/qris/status", {
            transaction_id: payment.transaction_id
        });

        payment.status = data.status;
        payment.updated_at = new Date().toISOString();
        payment.check_response = data;
        saveDB(db);

        if (
            PAID_STATUS.includes(data.status) ||
            FAILED_STATUS.includes(data.status)
        ) {
            return await finishPayment(
                ctx.telegram,
                payment,
                data.status
            );
        }

        return await ctx.answerCbQuery(
            `Payment status: ${data.status}`,
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
            .createHmac(
                "sha256",
                process.env.PAYMENT_API_KEY
            )
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
        payment.updated_at = new Date().toISOString();
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
        console.log(
            "Webhook error:",
            err.message
        );
        return res.status(500).json({
            success: false,
            error: "Internal server error"
        });
    }
});

bot.launch();

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
});