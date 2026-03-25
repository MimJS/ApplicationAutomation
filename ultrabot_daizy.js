import "dotenv/config";
import axios from "axios";
import nodeCron from "node-cron";

const BASE_URL = "https://ritm-dostavki.ru/api/v1";

let accessToken = "";
let currentEnergy = 0;
let boosterEndTime = 0;

const MAX_ENERGY = 10;

const N = {
  BOOSTER: "Мульти заказы",
  BURGER: "Бургер",
  COFFEE: "Кофе",
  CHOCOLATE: "Шоколад",
  WATER: "Вода",
};

const ITEM_ENERGY = {
  [N.BURGER]: 4,
  [N.COFFEE]: 3,
  [N.CHOCOLATE]: 2,
  [N.WATER]: 1,
};

let shop = {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────── AUTH ─────────────────
async function login() {
  const res = await axios.post(`${BASE_URL}/telegram_auth/login`, {
    telegramSessionValidationDto: {
      validationString: process.env.TELEGRAM_VALIDATION_STRING,
    },
  });

  accessToken = res.data.accessToken;
}

// ───────────────── SHOP ─────────────────
async function refreshShop() {
  const res = await axios.get(`${BASE_URL}/shop/get_offers`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  shop = {};
  for (const o of res.data.offers) {
    shop[o.name] = {
      id: o.id,
      purchasedAt: o.purchasedAt ? new Date(o.purchasedAt) : null,
      cooldown: o.requirements?.[0]?.payload?.Cooldown || "00:00:00",
    };
  }
}

function parseCd(str) {
  const [h, m, s] = str.split(":").map(Number);
  return (h * 3600 + m * 60 + s) * 1000;
}

function canBuy(name) {
  const o = shop[name];
  if (!o) return false;
  if (!o.purchasedAt) return true;

  const cd = parseCd(o.cooldown);
  return Date.now() - o.purchasedAt.getTime() >= cd;
}

// ───────────────── ENERGY ─────────────────
async function refreshEnergy() {
  const res = await axios.get(
    `${BASE_URL}/player/get_stat_by_id?statName=energy_current`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  currentEnergy = res.data.stat.currentValue;
}

// ───────────────── GAME ─────────────────
async function playGame(tag = "") {
  if (currentEnergy <= 0) return;

  try {
    await axios.post(
      `${BASE_URL}/game_session/start_game_session`,
      {},
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    await sleep(18000);

    const res = await axios.post(
      `${BASE_URL}/game_session/end_game_session`,
      { durationSeconds: 18, bonuses: 16 },
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    currentEnergy--;
    console.log(`🎮 ${tag} +${res.data.ratingDelta} | ⚡ ${currentEnergy}`);
  } catch (e) {
    console.log("game error");
  }
}

// ───────────────── SMART PURCHASE ─────────────────

// 🔥 освобождаем место под энергию
async function ensureSpace(gain) {
  while (currentEnergy + gain > MAX_ENERGY && currentEnergy > 0) {
    console.log("⚠️ освобождаю энергию");
    await playGame("drain");
    await sleep(500);
  }
}

// 🔥 умная покупка
async function smartBuy(name) {
  if (!canBuy(name)) return;

  const gain = ITEM_ENERGY[name] || 0;

  if (gain > 0) {
    await ensureSpace(gain);
  }

  await axios.post(
    `${BASE_URL}/shop/purchase_offer?id=${shop[name].id}`,
    {},
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  shop[name].purchasedAt = new Date();

  if (gain > 0) {
    currentEnergy = Math.min(MAX_ENERGY, currentEnergy + gain);
  }

  console.log(`🛒 ${name} (+${gain}) → ⚡ ${currentEnergy}`);
}

// ───────────────── BOOST ─────────────────
function boostActive() {
  return Date.now() < boosterEndTime;
}

// ───────────────── MAIN LOGIC ─────────────────
async function tick() {
  await refreshShop();
  await refreshEnergy();

  // 🔥 если буст активен — максимально агрессивно
  if (boostActive()) {
    // покупаем ВСЁ сразу
    for (const i of [N.BURGER, N.COFFEE, N.CHOCOLATE, N.WATER]) {
      if (canBuy(i)) {
        await smartBuy(i);
      }
    }

    if (currentEnergy > 0) {
      await playGame("BOOST");
    }

    return;
  }

  // 🔥 пробуем купить буст
  const allReady =
    canBuy(N.BOOSTER) &&
    canBuy(N.BURGER) &&
    canBuy(N.COFFEE) &&
    canBuy(N.CHOCOLATE) &&
    canBuy(N.WATER);

  if (allReady && currentEnergy === 10) {
    await smartBuy(N.BOOSTER);
    boosterEndTime = Date.now() + 20 * 60 * 1000;

    console.log("🔥 BOOST START");
    return;
  }

  // 🔥 вне буста

  // покупаем воду всегда
  if (canBuy(N.WATER)) {
    await smartBuy(N.WATER);
    return;
  }

  // шоколад 1 раз за цикл
  if (canBuy(N.CHOCOLATE)) {
    await smartBuy(N.CHOCOLATE);
    return;
  }

  // если энергия есть — играем
  if (currentEnergy > 0) {
    await playGame("farm");
    return;
  }

  await sleep(5000);
}

// ───────────────── LOOP ─────────────────
async function main() {
  await login();

  while (true) {
    try {
      await tick();
    } catch (e) {
      console.log("loop error");
      await sleep(5000);
    }
  }
}

main();

// рейтинг
nodeCron.schedule("0 * * * *", async () => {
  console.log("⏱ hourly ping");
});