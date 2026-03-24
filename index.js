import "dotenv/config";
import axios from "axios";

const BASE_URL = "https://ritm-dostavki.ru/api/v1";

let accessToken = "";
let tokenExpiresAt = null;
let currentEnergy = 0;

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

const OFFER_IDS = {
  BURGER: null,
  COFFEE: null,
  CACAO: null,
  WATER: null,
  BOOSTER: null,
};

const TIMEOUTS = {
  BURGER: null,
  COFFEE: null,
  CACAO: null,
  WATER: null,
  BOOSTER: null,
};

function getRandomInt(min, max) {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function login() {
  const payload = {
    telegramSessionValidationDto: {
      validationString: process.env.TELEGRAM_VALIDATION_STRING,
    },
    telegramMiniAppConnectionDto,
  };

  try {
    const response = await axios.post(
      `${BASE_URL}/telegram_auth/login`,
      payload,
      {
        headers: { "Content-Type": "application/json" },
      },
    );

    accessToken = response.data.accessToken;
    tokenExpiresAt = new Date(response.data.tokenExpiresAt);

    console.log(
      `✅ Логин успешен. Токен истекает: ${tokenExpiresAt.toISOString()}`,
    );
    scheduleTokenRefresh();
  } catch (error) {
    console.error("❌ Ошибка логина:", error.response?.data || error.message);
    await sendTelegramNotificationLogin(
      String(error.response?.data || error.message),
    );
    process.exit(1);
  }
}

function scheduleTokenRefresh() {
  const now = Date.now();
  const expires = tokenExpiresAt.getTime();
  let msBeforeExpiry = expires - now - 5 * 60 * 1000; // за 5 минут

  if (msBeforeExpiry < 0) msBeforeExpiry = 0;

  setTimeout(async () => {
    console.log("🔄 Автообновление токена...");
    await login();
  }, msBeforeExpiry);
}

async function checkEnergy() {
  try {
    const response = await axios.get(
      `${BASE_URL}/player/get_stat_by_id?statName=energy_current`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );

    currentEnergy = response.data.stat.currentValue;
    console.log(`⚡ Энергия: ${currentEnergy}`);

    if (currentEnergy > 0) {
      await playAllGames();
      console.log("Все игры сыграны. Проверка энергии через 60 сек...");
      setTimeout(checkEnergy, 60000);
    } else {
      console.log("Энергии нет → ждём 60 секунд");
      setTimeout(checkEnergy, 60000);
    }
  } catch (error) {
    console.error(
      "❌ Ошибка проверки энергии:",
      error.response?.data || error.message,
    );
    if (error.response?.status === 401) await login();
    setTimeout(checkEnergy, 60000);
  }
}

async function playAllGames() {
  while (currentEnergy > 0) {
    await playOneGame();
  }
}

async function playOneGame() {
  try {
    try {
      console.log("🎮 Создаём игровую сессию...");

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

      console.log("✅ Сессия создана");
    } catch (error) {
      // Обработка ошибки "Game session already exists"
      if (error.response?.status === 400) {
        const errorData = error.response.data;
        if (
          errorData?.errors?.some(
            (err) => err.errorCode === "Game session already exists",
          )
        ) {
          console.log(
            "⚠️ Сессия уже существует — пропускаем создание и получаем текущий seed",
          );

          const response = await axios.get(
            `${BASE_URL}/game_session/get_game_session_seed`,
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
              },
            },
          );

          console.log("✅ Seed сессии найден", response?.data?.seed);
          // Игнорируем ошибку и идём дальше к start_game_session
        } else {
          throw error; // другая 400 ошибка — пробрасываем
        }
      } else {
        throw error; // любая другая ошибка
      }
    }

    const gamePayload = {
      challengeType: 1,
      startTime: new Date().toISOString(),
    };
    await axios.post(
      `${BASE_URL}/game_session/start_game_session`,
      gamePayload,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      },
    );

    const time = await getRandomInt(
      process.env.GAME_TIME_MIN,
      process.env.GAME_TIME_MAX,
    );

    console.log("✅ Игра запущена...");
    console.log(`⏳ Ждём ${time} секунд...`);
    await new Promise((r) => setTimeout(r, time * 1000));

    // Финальный запрос (логично end_game_session по структуре API)
    const finishPayload = { durationSeconds: time, bonuses: 16 };
    const result = await axios.post(
      `${BASE_URL}/game_session/end_game_session`,
      finishPayload,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      },
    );

    console.log("✅ Игра завершена!", result.data);

    const ratingDelta = result.data.ratingDelta || 0;
    const currentRatingResponse = await axios.get(`${BASE_URL}/user/get_full`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });
    await sendTelegramNotification(ratingDelta, {
      money: currentRatingResponse?.data?.user?.player?.money || 0,
      rating: currentRatingResponse?.data?.user?.player?.rating || 0,
    });

    currentEnergy--;
    console.log(`Осталось жизней: ${currentEnergy}`);
  } catch (error) {
    console.error("❌ Ошибка игры:", error.response?.data || error.message);
    customTelegramMessage(
      `❌ Ошибка игры: ${String(error.response?.data || error.message)}`,
    );
    if (error.response?.status === 401) await login();
    currentEnergy--; // чтобы не застрять в цикле
  }
}

async function buyBurger() {
  clearTimeout(TIMEOUTS.BURGER);

  try {
    if (!OFFER_IDS.BURGER || currentEnergy > 0) {
      throw new Error("no id");
    }

    await axios.post(
      `${BASE_URL}/shop/purchase_offer?id=${OFFER_IDS.BURGER}`,
      {},
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    sendTelegramNotificationByEnergy("Бургер");
  } catch (error) {
    console.error(
      "❌ Бургер не куплен:",
      error.response?.data || error.message,
    );
  } finally {
    TIMEOUTS.BURGER = setTimeout(buyBurger, 60000);
  }
}

async function buyCoffee() {
  clearTimeout(TIMEOUTS.COFFEE);

  try {
    if (!OFFER_IDS.COFFEE || currentEnergy > 0) {
      throw new Error("no id");
    }

    await axios.post(
      `${BASE_URL}/shop/purchase_offer?id=${OFFER_IDS.COFFEE}`,
      {},
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    sendTelegramNotificationByEnergy("Кофе");
  } catch (error) {
    console.error("❌ Кофе не куплен:", error.response?.data || error.message);
  } finally {
    TIMEOUTS.COFFEE = setTimeout(buyCoffee, 60000);
  }
}

async function buyCacao() {
  clearTimeout(TIMEOUTS.CACAO);

  try {
    if (!OFFER_IDS.CACAO || currentEnergy > 0) {
      throw new Error("no id");
    }

    await axios.post(
      `${BASE_URL}/shop/purchase_offer?id=${OFFER_IDS.CACAO}`,
      {},
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    sendTelegramNotificationByEnergy("Шоколадка");
  } catch (error) {
    console.error(
      "❌ Шоколадка не куплена:",
      error.response?.data || error.message,
    );
  } finally {
    TIMEOUTS.CACAO = setTimeout(buyCacao, 60000);
  }
}

async function buyWater() {
  clearTimeout(TIMEOUTS.WATER);

  try {
    if (!OFFER_IDS.WATER || currentEnergy > 0) {
      throw new Error("no id");
    }

    await axios.post(
      `${BASE_URL}/shop/purchase_offer?id=${OFFER_IDS.WATER}`,
      {},
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    sendTelegramNotificationByEnergy("Вода");
  } catch (error) {
    console.error("❌ Вода не куплена:", error.response?.data || error.message);
  } finally {
    TIMEOUTS.WATER = setTimeout(buyWater, 60000);
  }
}

async function buyBooster() {
  clearTimeout(TIMEOUTS.BOOSTER);

  try {
    if (!OFFER_IDS.BOOSTER || currentEnergy <= 0) {
      throw new Error("no id");
    }

    await axios.post(
      `${BASE_URL}/shop/purchase_offer?id=${OFFER_IDS.BOOSTER}`,
      {},
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    sendTelegramNotificationByEnergy("Бустер");
  } catch (error) {
    console.error(
      "❌ Бустер не куплена:",
      error.response?.data || error.message,
    );
  } finally {
    TIMEOUTS.BOOSTER = setTimeout(buyBooster, 60000);
  }
}

async function prepareOfferIds() {
  try {
    const response = await axios.get(`${BASE_URL}/shop/get_offers`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const totalOffers = response?.data?.offers;
    OFFER_IDS.BOOSTER =
      totalOffers.find((v) => v.name == "Мульти заказы")?.id || null;
    OFFER_IDS.BURGER = totalOffers.find((v) => v.name == "Бургер")?.id || null;
    OFFER_IDS.WATER = totalOffers.find((v) => v.name == "Вода")?.id || null;
    OFFER_IDS.CACAO = totalOffers.find((v) => v.name == "Шоколад")?.id || null;
    OFFER_IDS.COFFEE = totalOffers.find((v) => v.name == "Кофе")?.id || null;

    await customTelegramMessage(
      `✅ Получены офферы: ${JSON.stringify(OFFER_IDS)}`,
    );
  } catch (error) {
    console.error(
      "❌ Не получилось получить офферы:",
      error.response?.data || error.message,
    );
    await customTelegramMessage(
      `❌ Не получилось получить офферы: ${String(error.response?.data || error.message)}`,
    );
    setTimeout(prepareOfferIds, 60000);
  }
}

async function sendTelegramNotification(ratingDelta, userData) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log(`📈 +${ratingDelta} очков рейтинга`);
    return;
  }

  try {
    await axios.post(`${process.env.TELEGRAM_URL}${token}/sendMessage`, {
      chat_id: chatId,
      text: `🎉 Игра завершена!\nНовый рейтинг: +${ratingDelta} очков\n\nРейтинг всего: ${userData?.rating}\nДенег: ${userData?.money}`,
    });
    console.log("📨 Уведомление отправлено в Telegram");
  } catch (e) {
    console.error("❌ Не удалось отправить в TG:", e.message);
  }
}

async function sendTelegramNotificationByEnergy(name) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log(`🎉 Куплен: ${name}`);
    return;
  }

  try {
    await axios.post(`${process.env.TELEGRAM_URL}${token}/sendMessage`, {
      chat_id: chatId,
      text: `🔸 Куплен ${name}`,
    });
    console.log("📨 Уведомление отправлено в Telegram");
  } catch (e) {
    console.error("❌ Не удалось отправить в TG:", e.message);
  }
}

async function sendTelegramNotificationLogin(error) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return;
  }

  try {
    await axios.post(`${process.env.TELEGRAM_URL}${token}/sendMessage`, {
      chat_id: chatId,
      text: `❌ Ошибка авторизации: ${error}`,
    });
    console.log("📨 Уведомление отправлено в Telegram");
  } catch (e) {
    console.error("❌ Не удалось отправить в TG:", e.message);
  }
}

async function customTelegramMessage(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return;
  }

  try {
    await axios.post(`${process.env.TELEGRAM_URL}${token}/sendMessage`, {
      chat_id: chatId,
      text: message || "Пустое сообщение",
    });
    console.log("📨 Уведомление отправлено в Telegram");
  } catch (e) {
    console.error("❌ Не удалось отправить в TG:", e.message);
  }
}

async function main() {
  if (!process.env.TELEGRAM_VALIDATION_STRING) {
    console.error("❌ Добавь TELEGRAM_VALIDATION_STRING в .env");
    process.exit(1);
  }
  await login();
  await prepareOfferIds();

  if (process.env.BUY_BOOSTER === "1") {
    buyBooster();
  }

  if (process.env.BUY_BURGER === "1") {
    buyBurger();
  }

  if (process.env.BUY_COFFEE === "1") {
    buyCoffee();
  }

  if (process.env.BUY_CACAO === "1") {
    buyCacao();
  }

  if (process.env.BUY_WATER === "1") {
    buyWater();
  }

  await checkEnergy();
}

main().catch(console.error);
