import "dotenv/config";
import axios from "axios";
import nodeCron from "node-cron";
import fs from "fs";
import { fileURLToPath } from "url";
import path, { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BASE_URL = "https://ritm-dostavki.ru/api/v1";
axios.defaults.timeout = 15_000;

// ─── AUTH STATE ──────────────────────────────────────────────────────────────
let accessToken = "";
let tokenExpiresAt = null;
let tokenRefreshTimer = null;

// ─── GAME STATE ──────────────────────────────────────────────────────────────
let currentEnergy = 0;
let boosterEndTime = null; // когда истекает +30%
let drainComplete = false; // слиты ли обычные 10 энергий после покупки бустера
let chocolateBoughtThisBreak = false;
let gamesPlayedSinceBoostEnded = 0;
let boostWasActive = false; // для детектирования перехода boost→break

// ─── SHOP CACHE ───────────────────────────────────────────────────────────────
let shopData = {};
let shopCacheTs = 0;
let energyCacheTs = 0;
const SHOP_TTL_MS = 30_000;
const ENERGY_TTL_MS = 15_000;

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const MAX_ENERGY = 10;
const BOOST_DURATION_MS = 20 * 60 * 1000;

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

const telegramMiniAppConnectionDto = {
  appVersion: "9.5",
  manufacturer: "",
  model: "",
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0",
  sdkVersion: "tdesktop",
  androidVersion: "",
  performanceClass: "",
};

// ─── UTILS ───────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getRandomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function parseCooldown(str) {
  if (!str) return 0;
  const [h = 0, m = 0, s = 0] = str.split(":").map(Number);
  return (h * 3600 + m * 60 + s) * 1000;
}

// ─── TELEGRAM ────────────────────────────────────────────────────────────────
// Fire-and-forget: не блокирует основной цикл (~35с экономии за ультра-цикл)
function tg(text) {
  console.log("[MSG]", text);
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  axios
    .post(`${process.env.TELEGRAM_URL}${token}/sendMessage`, {
      chat_id: chatId,
      text,
    })
    .catch((e) => console.error("TG error:", e.message));
}

// Awaitable версия — только для критических мест (перед process.exit и т.п.)
async function tgWait(text) {
  console.log("[MSG]", text);
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await axios.post(`${process.env.TELEGRAM_URL}${token}/sendMessage`, {
      chat_id: chatId,
      text,
    });
  } catch (e) {
    console.error("TG error:", e.message);
  }
}

// ─── AUTH ────────────────────────────────────────────────────────────────────
async function login() {
  try {
    const res = await axios.post(
      `${BASE_URL}/telegram_auth/login`,
      {
        telegramSessionValidationDto: {
          validationString: process.env.TELEGRAM_VALIDATION_STRING,
        },
        telegramMiniAppConnectionDto,
      },
      { headers: { "Content-Type": "application/json" } },
    );
    accessToken = res.data.accessToken;
    tokenExpiresAt = new Date(res.data.tokenExpiresAt);
    console.log(`✅ Логин. Токен до: ${tokenExpiresAt.toISOString()}`);
    scheduleTokenRefresh();
  } catch (e) {
    console.error("❌ Логин:", e.response?.data || e.message);
    await tgWait(
      `❌ Ошибка авторизации: ${String(e.response?.data || e.message)}`,
    );
    process.exit(1);
  }
}

function scheduleTokenRefresh() {
  if (tokenRefreshTimer) clearTimeout(tokenRefreshTimer);
  const delay = Math.max(0, tokenExpiresAt.getTime() - Date.now() - 5 * 60_000);
  tokenRefreshTimer = setTimeout(async () => {
    console.log("🔄 Обновление токена...");
    await login();
  }, delay);
}

// ─── SHOP ────────────────────────────────────────────────────────────────────
async function refreshShop(force = false) {
  if (!force && Date.now() - shopCacheTs < SHOP_TTL_MS) return;
  try {
    const res = await axios.get(`${BASE_URL}/shop/get_offers`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = {};
    for (const offer of res.data.offers) {
      const cdReq = offer.requirements?.find(
        (r) => r.type === "PurchaseCooldownRequirement",
      );
      data[offer.name] = {
        id: offer.id,
        purchasedAt: offer.purchasedAt ? new Date(offer.purchasedAt) : null,
        cooldownMs: cdReq ? parseCooldown(cdReq.payload.Cooldown) : 0,
      };
    }
    shopData = data;
    shopCacheTs = Date.now();
    console.log("🛒 Магазин обновлён");
  } catch (e) {
    console.error("❌ Shop refresh:", e.response?.data || e.message);
    if (e.response?.status === 401) await login();
  }
}

function canBuy(name) {
  const d = shopData[name];
  if (!d?.id) return false;
  if (!d.purchasedAt || d.cooldownMs === 0) return true;
  return Date.now() - d.purchasedAt.getTime() >= d.cooldownMs;
}

function cdMs(name) {
  const d = shopData[name];
  if (!d?.purchasedAt || d.cooldownMs === 0) return 0;
  return Math.max(0, d.cooldownMs - (Date.now() - d.purchasedAt.getTime()));
}

function cdMin(name) {
  return cdMs(name) / 60_000;
}

// ─── ENERGY ──────────────────────────────────────────────────────────────────
async function refreshEnergy(force = false) {
  if (!force && Date.now() - energyCacheTs < ENERGY_TTL_MS) return;
  try {
    const res = await axios.get(
      `${BASE_URL}/player/get_stat_by_id?statName=energy_current`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    currentEnergy = res.data.stat.currentValue;
    energyCacheTs = Date.now();
    console.log(`⚡ Энергия: ${currentEnergy}`);
  } catch (e) {
    console.error("❌ Energy refresh:", e.response?.data || e.message);
    if (e.response?.status === 401) await login();
  }
}

// ─── GAME ────────────────────────────────────────────────────────────────────
async function playGame(phase = "") {
  const boostActive = boosterEndTime !== null && Date.now() < boosterEndTime;
  let energyConsumed = false;
  try {
    // Создать сессию
    try {
      await axios.post(
        `${BASE_URL}/game_session/create_game_session`,
        {},
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        },
      );
    } catch (e) {
      const alreadyExists =
        e.response?.status === 400 &&
        e.response.data?.errors?.some(
          (err) => err.errorCode === "Game session already exists",
        );
      if (!alreadyExists) throw e;
      console.log("⚠️ Сессия уже существует — продолжаем");
    }

    // Запустить сессию — после этого сервер списывает энергию
    await axios.post(
      `${BASE_URL}/game_session/start_game_session`,
      { challengeType: 1, startTime: new Date().toISOString() },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      },
    );
    energyConsumed = true;

    const gameTime = getRandomInt(
      parseInt(process.env.GAME_TIME_MIN || "15"),
      parseInt(process.env.GAME_TIME_MAX || "20"),
    );
    console.log(`🎮 [${phase}] Игра ${gameTime}с...`);
    await sleep(gameTime * 1000);

    // Завершить сессию
    const result = await axios.post(
      `${BASE_URL}/game_session/end_game_session`,
      { durationSeconds: gameTime, bonuses: 16 },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      },
    );

    const delta = result.data.ratingDelta || 0;
    const newEnergy = Math.max(0, currentEnergy - 1);

    // Получить статы пользователя (не блокируем — fire-and-forget)
    axios
      .get(`${BASE_URL}/user/get_full`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      .then((userRes) => {
        const money = userRes.data?.user?.player?.money || 0;
        const rating = userRes.data?.user?.player?.rating || 0;
        tg(
          `🎮 Игра${boostActive ? " 🔥(+30%)" : ""} [${phase}]\n` +
            `+${delta} рейтинга | ⚡ ${currentEnergy}→${newEnergy}\n` +
            `📊 Рейтинг: ${rating} | 💰 ${money}`,
        );
      })
      .catch(() => {
        tg(
          `🎮 Игра${boostActive ? " 🔥(+30%)" : ""} [${phase}]: +${delta} рейтинга | ⚡ ${currentEnergy}→${newEnergy}`,
        );
      });

    currentEnergy = newEnergy;
    energyCacheTs = 0;

    if (!boostActive) {
      gamesPlayedSinceBoostEnded++;
    }

    return true;
  } catch (e) {
    console.error("❌ Игра:", e.response?.data || e.message);
    tg(`❌ Ошибка игры [${phase}]: ${String(e.response?.data || e.message)}`);
    if (e.response?.status === 401) await login();
    if (energyConsumed) {
      currentEnergy = Math.max(0, currentEnergy - 1);
    }
    energyCacheTs = 0;
    return false;
  }
}

// ─── PURCHASE ────────────────────────────────────────────────────────────────
async function purchase(name, energyGain = 0) {
  const d = shopData[name];
  if (!d?.id) {
    console.warn(`⚠️ ${name}: нет ID в shopData`);
    return false;
  }
  if (energyGain > 0 && currentEnergy + energyGain > MAX_ENERGY) {
    console.warn(
      `⚠️ ${name}: переполнение (${currentEnergy}+${energyGain}>${MAX_ENERGY})`,
    );
    return false;
  }
  try {
    await axios.post(
      `${BASE_URL}/shop/purchase_offer?id=${d.id}`,
      {},
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    shopData[name] = { ...d, purchasedAt: new Date() };
    shopCacheTs = 0;
    if (energyGain > 0) {
      currentEnergy = Math.min(MAX_ENERGY, currentEnergy + energyGain);
      energyCacheTs = 0;
    }
    console.log(
      `✅ Куплено: ${name}${energyGain > 0 ? ` (+${energyGain} энергии → ${currentEnergy})` : ""}`,
    );
    return true;
  } catch (e) {
    console.error(`❌ Покупка ${name}:`, e.response?.data || e.message);
    await tg(
      `❌ Ошибка покупки ${name}: ${String(e.response?.data || e.message)}`,
    );
    if (e.response?.status === 401) await login();
    return false;
  }
}

// ─── BOOST HELPERS ───────────────────────────────────────────────────────────
function isBoostActive() {
  return boosterEndTime !== null && Date.now() < boosterEndTime;
}

function boostRemMin() {
  if (!isBoostActive()) return 0;
  return (boosterEndTime - Date.now()) / 60_000;
}

function minsToBooster() {
  return cdMin(N.BOOSTER);
}

function canBuyBooster() {
  if (!canBuy(N.BOOSTER)) return false;
  if (currentEnergy < MAX_ENERGY) return false;
  return [N.BURGER, N.COFFEE, N.CHOCOLATE, N.WATER].every((n) => canBuy(n));
}

// Прогноз энергии к моменту покупки бустера.
// Шоколад НЕ включается: он заполняет дефицит до 10, а не создаёт излишек.
// Цикл ~83 мин: шоколад покупается на ~T+43 перерыва → CD истекает T+83 = время бустера.
function projectEnergyAtBooster(minsLeft) {
  if (minsLeft <= 0) return currentEnergy;
  let e = currentEnergy;

  // Пассивная регенерация: 1 энергия каждые 10 минут
  e = Math.min(MAX_ENERGY, e + Math.floor(minsLeft / 10));

  // Водяные покупки до T-22мин (оставляем воду готовой для условия бустера)
  const waterCdLeft = cdMin(N.WATER);
  for (let t = waterCdLeft; t <= minsLeft - 22 && e < MAX_ENERGY; t += 20) {
    e = Math.min(MAX_ENERGY, e + 1);
  }

  return e;
}

// ─── СКУПКА ВСЕХ ВОССТАНОВЛЕНИЙ ПОД БУСТЕРОМ ─────────────────────────────────
async function buyAllRestorations() {
  const order = [N.BURGER, N.COFFEE, N.CHOCOLATE, N.WATER];
  const bought = [];
  const skipped = [];

  for (const name of order) {
    const gain = ITEM_ENERGY[name];
    if (canBuy(name)) {
      if (currentEnergy + gain > MAX_ENERGY) {
        skipped.push(`${name} (${currentEnergy}+${gain}>${MAX_ENERGY})`);
      } else {
        const ok = await purchase(name, gain);
        if (ok) bought.push(`${name}(+${gain})`);
        await sleep(600);
      }
    } else {
      skipped.push(`${name}(КД ${cdMin(name).toFixed(0)}мин)`);
    }
  }

  await tg(
    `🛒 Скупка под бустером:\n` +
      `✅ Куплено: ${bought.join(", ") || "—"}\n` +
      `⏭ Пропущено: ${skipped.join(", ") || "—"}\n` +
      `⚡ Энергия: ${currentEnergy}`,
  );
}

// ─── ГЛАВНЫЙ ТИК ─────────────────────────────────────────────────────────────
async function tick() {
  await refreshShop();
  await refreshEnergy();

  const boostActive = isBoostActive();
  const boostMinLeft = boostRemMin();
  const minsLeft = minsToBooster();

  // Детектируем переход boost → break
  if (boostWasActive && !boostActive && boosterEndTime) {
    boostWasActive = false;
    gamesPlayedSinceBoostEnded = 0;
    chocolateBoughtThisBreak = false;
    await tg(
      `⏰ Бустер закончился! Начинается перерыв.\n` +
        `⚡ Энергия: ${currentEnergy} | До следующего бустера: ~${minsLeft.toFixed(0)} мин`,
    );
  }
  if (boostActive && !boostWasActive) {
    boostWasActive = true;
  }

  // ═══════════════════════════════════════════════════════
  //  ФАЗА БУСТЕРА
  // ═══════════════════════════════════════════════════════
  if (boostActive) {
    if (!drainComplete) {
      // Субфаза A: сливаем до 0, чтобы все 4 восстановления поместились (4+3+2+1=10)
      if (currentEnergy === 0) {
        drainComplete = true;
        await tg(
          `✅ Обычная энергия слита до ${currentEnergy}!\n` +
            `🔥 Скупаем ВСЕ восстановления под бустером (+30%, ещё ${boostMinLeft.toFixed(1)} мин)`,
        );
        await buyAllRestorations();
        return;
      }
      const reason =
        `🎮 [СЛИВ] Сливаю энергию ${currentEnergy}→${currentEnergy - 1} под бустером (+30%).\n` +
        `Не покупаю восстановления — сначала надо слить все 10 обычных энергий.\n` +
        `Бустер ещё ${boostMinLeft.toFixed(1)} мин.`;
      await tg(reason);
      await playGame("СЛИВ");
      return;
    }

    // Субфаза B: играем на купленные восстановления
    if (currentEnergy > 0) {
      const reason = `🎮 [БУСТЕР] Играю под бустером (+30%): энергия=${currentEnergy}, осталось ${boostMinLeft.toFixed(1)} мин.`;
      console.log(reason);
      await playGame("БУСТЕР");
      return;
    }

    // Нет энергии под бустером — редкий случай (ждём пассивную регенерацию)
    const msg =
      `⚡ Нет энергии под бустером. Бустер ещё ${boostMinLeft.toFixed(1)} мин.\n` +
      `Ожидаю пассивную регенерацию (+1 за 10 мин)...`;
    await tg(msg);
    await sleep(15_000);
    return;
  }

  // ═══════════════════════════════════════════════════════
  //  ПРОВЕРКА ПОКУПКИ БУСТЕРА
  // ═══════════════════════════════════════════════════════
  if (canBuyBooster()) {
    await tg(
      `🚀 ВСЕ УСЛОВИЯ ВЫПОЛНЕНЫ!\n` +
        `⚡ Энергия=${currentEnergy}=10, все КД готовы.\n` +
        `ПОКУПАЕМ БУСТЕР!`,
    );
    const ok = await purchase(N.BOOSTER);
    if (ok) {
      boosterEndTime = Date.now() + BOOST_DURATION_MS;
      drainComplete = false;
      boostWasActive = false;
      await tg(
        `🔥 Бустер активен! +30% к рейтингу на 20 минут.\n` +
          `Начинаем слив 10 обычных энергий (без покупки восстановлений).`,
      );
    }
    return;
  }

  // ═══════════════════════════════════════════════════════
  //  ФАЗА ПЕРЕРЫВА
  // ═══════════════════════════════════════════════════════

  // Составим объяснение, почему бустер ещё не покупаем
  const boosterBlockReasons = [];
  if (!canBuy(N.BOOSTER))
    boosterBlockReasons.push(`бустер КД=${cdMin(N.BOOSTER).toFixed(0)}мин`);
  if (currentEnergy < MAX_ENERGY)
    boosterBlockReasons.push(`энергия=${currentEnergy}<10`);
  for (const n of [N.BURGER, N.COFFEE, N.CHOCOLATE, N.WATER]) {
    if (!canBuy(n))
      boosterBlockReasons.push(`${n} КД=${cdMin(n).toFixed(0)}мин`);
  }

  // ── Вода: покупаем агрессивно ─────────────────────────────────────────────
  if (canBuy(N.WATER)) {
    if (currentEnergy + 1 > MAX_ENERGY) {
      const reason =
        `💧 Вода готова (+1), но энергия=${currentEnergy}=10 — переполнение!\n` +
        `Играю сначала, чтобы не потерять покупку воды.`;
      tg(reason);
      await playGame("пред-вода");
      return;
    }
    if (minsLeft > 22) {
      const reason =
        `💧 Покупаю воду (+1 энергии).\n` +
        `До бустера ${minsLeft.toFixed(0)}мин > 22мин: вода успеет зарядиться (КД 20мин) к следующему бустеру.`;
      tg(reason);
      await purchase(N.WATER, ITEM_ENERGY[N.WATER]);
      return;
    }
    if (currentEnergy === 0) {
      const reason =
        `💧 Покупаю воду (+1) — энергия=0, нечем играть.\n` +
        `До бустера ${minsLeft.toFixed(0)}мин < 22мин, но простаивать хуже, чем потратить воду.`;
      tg(reason);
      await purchase(N.WATER, ITEM_ENERGY[N.WATER]);
      return;
    }
    console.log(
      `💧 Вода готова, но до бустера ${minsLeft.toFixed(1)}мин < 22мин и energy=${currentEnergy} > 0 — держу для условия покупки.`,
    );
  }

  // ── Шоколадка: один раз за перерыв, покупаем сразу как КД истёк ────────────
  // Стратегия ~83 мин: шоколад куплен при бустере (~T+3), КД истекает ~T+43.
  // Покупаем в перерыве при T+43 → следующий CD истечёт T+83 = момент бустера ✓
  if (!chocolateBoughtThisBreak && canBuy(N.CHOCOLATE)) {
    if (currentEnergy + 2 > MAX_ENERGY) {
      const reason =
        `🍫 Шоколад готов (+2), но ${currentEnergy}+2=${currentEnergy + 2}>${MAX_ENERGY} — переполнение!\n` +
        `Сначала играю, потом покупаю шоколадку.`;
      await tg(reason);
      await playGame("пред-шоколад");
      return;
    }
    const reason =
      `🍫 Покупаю шоколадку (+2) — КД истёк, берём сразу.\n` +
      `После покупки CD=40мин → шоколад снова будет готов к следующему бустеру (~T+83).\n` +
      `До бустера: ${minsLeft.toFixed(0)} мин. ⚡ ${currentEnergy}→${currentEnergy + 2}`;
    await tg(reason);
    const ok = await purchase(N.CHOCOLATE, ITEM_ENERGY[N.CHOCOLATE]);
    if (ok) chocolateBoughtThisBreak = true;
    return;
  }

  // ── Играть или держать энергию ────────────────────────────────────────────
  if (currentEnergy === 0) {
    const nextWaterMin = cdMin(N.WATER);
    const reason =
      `⚡ Нет энергии. Жду пассивную регенерацию (+1 каждые 10 мин).\n` +
      `💧 Следующая вода через ${nextWaterMin.toFixed(0)} мин.\n` +
      `⏳ Бустер недоступен: [${boosterBlockReasons.join("; ")}]`;
    await tg(reason);
    const waitMs = Math.min(
      60_000,
      nextWaterMin > 0 ? nextWaterMin * 60_000 : 60_000,
    );
    await sleep(waitMs);
    return;
  }

  const projected = projectEnergyAtBooster(minsLeft);

  // Играем только при РЕАЛЬНОМ излишке (projected > 10, а не = 10).
  // При projected = 10 — шоколад или рег. покроют ровно дефицит, игра нарушит баланс.
  if (projected > MAX_ENERGY) {
    const surplus = projected - MAX_ENERGY;
    const reason =
      `🎮 [ПЕРЕРЫВ] Трачу энергию (${currentEnergy}). Излишек: +${surplus}.\n` +
      `Прогноз к бустеру (${minsLeft.toFixed(0)}мин): ~${projected}/10 — есть реальный излишек, трачу.`;
    console.log(reason);
    await playGame("ПЕРЕРЫВ");
    return;
  }

  // Держим энергию — пассивная рег + вода + шоколад наберут ровно 10 к бустеру
  const waitSec = Math.min(
    60,
    Math.max(20, minsLeft > 0 ? Math.floor(minsLeft * 6) : 30),
  );
  const chocolateNote =
    !chocolateBoughtThisBreak && canBuy(N.CHOCOLATE)
      ? ` | 🍫 шоколад доступен`
      : !chocolateBoughtThisBreak
        ? ` | 🍫 шоколад через ${cdMin(N.CHOCOLATE).toFixed(0)}мин`
        : "";
  const reason =
    `⏳ Держу ${currentEnergy} энергии (без игры).\n` +
    `Прогноз к бустеру (${minsLeft.toFixed(0)}мин): ${projected}/10 — дефицит, рег. покроет.${chocolateNote}\n` +
    `Жду ${waitSec}с. Бустер: [${boosterBlockReasons.join("; ")}]`;
  await tg(reason);
  await sleep(waitSec * 1_000);
}

// ─── РЕЙТИНГ ─────────────────────────────────────────────────────────────────
async function saveRating() {
  if (!accessToken) return;
  try {
    const res = await axios.get(
      `${BASE_URL}/rating/get_top?PageNotationRequestDto.Page=1&PageNotationRequestDto.PageSize=200`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const iso = new Date().toISOString().replace(/:/g, "-");
    const dir = path.join(__dirname, "rating_data");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (res.data?.topPlayers?.items) {
      fs.writeFileSync(
        path.join(dir, `${iso}.json`),
        JSON.stringify(res.data.topPlayers.items),
      );
    }
    await tg(`👀 #${res.data?.myPlace} место в рейтинге`);
  } catch (e) {
    console.error("❌ Рейтинг:", e.message);
  }
}

// ─── ИНИЦИАЛИЗАЦИЯ СОСТОЯНИЯ ИЗ ДАННЫХ МАГАЗИНА ──────────────────────────────
function initStateFromShop() {
  const now = Date.now();
  const booster = shopData[N.BOOSTER];
  const chocolate = shopData[N.CHOCOLATE];
  const lines = [];

  // Текущие КД всех предметов
  const cdStatus = {};
  for (const name of [N.BOOSTER, N.BURGER, N.COFFEE, N.CHOCOLATE, N.WATER]) {
    const rem = cdMin(name);
    cdStatus[name] = rem;
    const purchAt = shopData[name]?.purchasedAt;
    const purchStr = purchAt
      ? `куплен ${((now - purchAt.getTime()) / 60_000).toFixed(0)}мин назад`
      : "никогда";
    lines.push(
      `  ${name}: ${rem > 0 ? `КД ${rem.toFixed(1)}мин` : "готов"} (${purchStr})`,
    );
  }

  // Максимальный КД — через сколько все будут готовы
  const maxCd = Math.max(...Object.values(cdStatus));
  const bottleneck = Object.entries(cdStatus).find(([, v]) => v === maxCd)?.[0];

  // ─── Фаза 1: Бустер активен ──────────────────────────────────────────────
  if (booster?.purchasedAt) {
    const elapsed = now - booster.purchasedAt.getTime();

    if (elapsed < BOOST_DURATION_MS) {
      boosterEndTime = booster.purchasedAt.getTime() + BOOST_DURATION_MS;
      const remMin = (boosterEndTime - now) / 60_000;

      // Определяем drain: если энергия низкая И бустер куплен недавно
      // (первые ~4мин = слив 10 энергий), drain ещё не завершён
      const boostElapsedMin = elapsed / 60_000;
      if (currentEnergy === 0 || boostElapsedMin > 5) {
        drainComplete = true;
      } else {
        drainComplete = false;
      }

      lines.push(
        `\n🔥 БУСТЕР АКТИВЕН! Осталось ${remMin.toFixed(1)}мин`,
        `  drain: ${drainComplete ? "завершён" : "в процессе"} (energy=${currentEnergy})`,
      );
      tg(
        `🤖 UltraBot: подключаюсь к АКТИВНОМУ бустеру\n` +
          `⚡ Энергия: ${currentEnergy} | Бустер ещё ${remMin.toFixed(1)}мин\n` +
          `Drain: ${drainComplete ? "завершён → играю" : "продолжаю слив"}\n` +
          lines.join("\n"),
      );
      return;
    }

    // ─── Фаза 2: Бустер истёк — мы в перерыве ────────────────────────────────
    const boosterEndedAt = booster.purchasedAt.getTime() + BOOST_DURATION_MS;
    const breakElapsedMin = (now - boosterEndedAt) / 60_000;

    // Шоколад: куплен ли ПОСЛЕ окончания бустера?
    if (chocolate?.purchasedAt) {
      const chocTime = chocolate.purchasedAt.getTime();
      chocolateBoughtThisBreak = chocTime > boosterEndedAt;
    }

    // Оценка сыгранных игр в перерыве:
    // За breakElapsedMin минут: пассивная рег ~1/10мин + вода ~1/20мин + шоколад 2 раз
    // Грубо: ~1 игра на каждые 7-8 минут перерыва
    gamesPlayedSinceBoostEnded = Math.min(20, Math.floor(breakElapsedMin / 7));

    lines.push(
      `\n⏳ ПЕРЕРЫВ: бустер кончился ${breakElapsedMin.toFixed(0)}мин назад`,
      `  Шоколад в перерыве: ${chocolateBoughtThisBreak ? "уже куплен" : "не куплен"}`,
      `  ~${gamesPlayedSinceBoostEnded} игр сыграно (оценка)`,
      `  Все КД готовы через: ${maxCd.toFixed(0)}мин (узкое место: ${bottleneck})`,
      `  До бустера: нужно ещё energy=${MAX_ENERGY - currentEnergy} и ${maxCd.toFixed(0)}мин КД`,
    );
  } else {
    // ─── Фаза 3: Бустер никогда не покупался ─────────────────────────────────
    lines.push(
      `\n🆕 Бустер ещё не покупался.`,
      `  Все КД готовы через: ${maxCd.toFixed(0)}мин (узкое место: ${bottleneck || "—"})`,
    );
  }

  // Прогноз: когда можно купить бустер
  const minsLeft = maxCd;
  const projected = projectEnergyAtBooster(minsLeft);
  const energyGap = MAX_ENERGY - currentEnergy;
  const passiveRegenMin = energyGap * 10;

  let readyInMin;
  if (canBuyBooster()) {
    readyInMin = 0;
  } else {
    readyInMin = Math.max(maxCd, passiveRegenMin);
  }

  lines.push(
    `\n📊 ПРОГНОЗ:`,
    `  Энергия сейчас: ${currentEnergy}/${MAX_ENERGY}`,
    `  Прогноз энергии к бустеру: ~${projected}/${MAX_ENERGY}`,
    `  Бустер возможен через: ~${readyInMin.toFixed(0)} мин`,
    readyInMin === 0 ? `  ✅ Бустер можно купить ПРЯМО СЕЙЧАС!` : "",
  );

  const report = lines.filter(Boolean).join("\n");
  console.log(report);
  tg(
    `🤖 UltraBot запущен — выравнивание цикла:\n⚡ Энергия: ${currentEnergy}\n${report}`,
  );
}

// ─── ГЛАВНЫЙ ЦИКЛ ────────────────────────────────────────────────────────────
async function main() {
  if (!process.env.TELEGRAM_VALIDATION_STRING) {
    console.error("❌ TELEGRAM_VALIDATION_STRING обязателен в .env");
    process.exit(1);
  }

  await login();
  await refreshShop(true);
  await refreshEnergy(true);
  initStateFromShop();

  const loop = async () => {
    try {
      await tick();
    } catch (e) {
      console.error("❌ Ошибка цикла:", e.message);
      await tg(`❌ Ошибка основного цикла: ${e.message}`);
      await sleep(15_000);
    }
    setTimeout(loop, 2_000);
  };

  loop();
}

main().catch(console.error);

// Каждый час сохраняем рейтинг
nodeCron.schedule("0 * * * *", () => saveRating());
