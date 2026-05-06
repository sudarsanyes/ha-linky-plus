import { HomeAssistantClient } from './ha.js';
import { LinkyClient } from './linky.js';
import { getUserConfig, MeterConfig } from './config.js';
import { getMeterHistory } from './history.js';
import { formatAsStatistics, groupDataPointsByHour, incrementSums, DataPoint } from './format.js';
import { computeCosts, EntityHistoryData } from './cost.js';
import { debug, error, info, warn } from './log.js';
import cron from 'node-cron';
import dayjs from 'dayjs';

const HA_HTTP_URL = (process.env.WS_URL || 'ws://supervisor/core/websocket')
  .replace(/^ws/, 'http')
  .replace('/api/websocket', '');

const TOKEN = process.env.SUPERVISOR_TOKEN;

async function publishYesterdaySensorsFromData(
  energyData: DataPoint[],
  costsData: DataPoint[] | undefined,
  overhead = 0.826,
) {
  const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');

  info(`[linky-plus] publishYesterdaySensorsFromData called for ${yesterday}`);

  const yesterdayEnergy = energyData.filter(d =>
    dayjs(d.date).format('YYYY-MM-DD') === yesterday
  );

  info(`[linky-plus] Found ${yesterdayEnergy.length} energy points for yesterday`);

  if (yesterdayEnergy.length === 0) {
    warn('[linky-plus] No energy data found for yesterday, skipping publish');
    return;
  }

  const whYesterday = yesterdayEnergy.reduce((sum, d) => sum + d.value, 0);
  const kwhYesterday = Number((whYesterday / 1000).toFixed(2));
  info(`[linky-plus] Energy raw sum: ${whYesterday} Wh → ${kwhYesterday} kWh`);

  let costRaw = 0;
  let costWithOverhead = 0;

  if (costsData && costsData.length > 0) {
    const yesterdayCosts = costsData.filter(d =>
      dayjs(d.date).format('YYYY-MM-DD') === yesterday
    );

    info(`[linky-plus] Found ${yesterdayCosts.length} cost points for yesterday`);
    info(`[linky-plus] Sample cost points (first 3): ${JSON.stringify(yesterdayCosts.slice(0, 3))}`);

    costRaw = yesterdayCosts.reduce((sum, d) => sum + d.value, 0);
    costWithOverhead = Number((costRaw + overhead).toFixed(2));

    info(`[linky-plus] Cost raw sum: ${costRaw} €`);
    info(`[linky-plus] Cost raw + overhead (${overhead}): ${costWithOverhead} €`);
  } else {
    info('[linky-plus] No cost data available');
  }

  info(`[linky-plus] Publishing sensors → ${kwhYesterday} kWh / ${costWithOverhead} € (${yesterday})`);

  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
  };

  const res1 = await fetch(`${HA_HTTP_URL}/api/states/sensor.linky_yesterday_kwh`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      state: kwhYesterday,
      attributes: {
        unit_of_measurement: 'kWh',
        friendly_name: 'Linky Yesterday Consumption',
        device_class: 'energy',
        state_class: 'measurement',
        date: yesterday,
      },
    }),
  });

  if (!res1.ok) {
    warn(`[linky-plus] Failed to push kWh sensor: ${res1.status} ${await res1.text()}`);
  } else {
    info(`[linky-plus] kWh sensor published successfully → ${kwhYesterday} kWh`);
  }

  const res2 = await fetch(`${HA_HTTP_URL}/api/states/sensor.linky_yesterday_cost`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      state: costWithOverhead,
      attributes: {
        unit_of_measurement: '€',
        friendly_name: 'Linky Yesterday Cost (with overhead)',
        icon: 'mdi:currency-eur',
        date: yesterday,
      },
    }),
  });

  if (!res2.ok) {
    warn(`[linky-plus] Failed to push cost sensor: ${res2.status} ${await res2.text()}`);
  } else {
    info(`[linky-plus] Cost sensor published successfully → ${costWithOverhead} € (raw: ${costRaw} + overhead: ${overhead})`);
  }
}

async function main() {
  debug('HA Linky is starting');

  const userConfig = getUserConfig();

  if (userConfig.meters.length === 0) {
    warn('Add-on is not configured properly');
    return;
  }

  const haClient = new HomeAssistantClient();
  await haClient.connect();

  for (const config of userConfig.meters) {
    if (config.action === 'reset') {
      await haClient.purge(config.prm, config.production);
      info(`Statistics removed successfully for PRM ${config.prm}`);
    }
  }

  async function sync(config: MeterConfig) {
    info(
      `[${dayjs().format('DD/MM HH:mm')}] Sync start for ${
        config.production ? 'production' : 'consumption'
      }`,
    );

    const lastStatistic = await haClient.findLastStatistic({
      prm: config.prm,
      isProduction: config.production,
    });

    if (!lastStatistic) {
      warn('No previous statistics found');
      return;
    }

    const isSyncingNeeded =
      dayjs(lastStatistic.start).isBefore(dayjs().subtract(2, 'days')) &&
      dayjs().hour() >= 6;

    const client = new LinkyClient(config.token, config.prm, config.production);

    // Always fetch yesterday for sensor publishing
    const yesterdayStart = dayjs().subtract(1, 'day').startOf('day');
    const energyData = await client.getEnergyData(yesterdayStart);

    info(`[linky-plus] Retrieved ${energyData.length} points for yesterday fetch`);

    // Guard — if API returned nothing, skip publish and stop here
    if (energyData.length === 0) {
      warn('[linky-plus] No data retrieved from API, skipping sensor publish and statistics sync');
      return;
    }

    let costsData: DataPoint[] | undefined;

    if (config.costs) {
      const entityHistory = await fetchEntityHistory(haClient, config.costs, energyData);
      const rawCosts = computeCosts(energyData, config.costs, entityHistory);
      costsData = groupDataPointsByHour(rawCosts);
    }

    // Group energy by hour to match statistics granularity
    const groupedEnergyData = groupDataPointsByHour(energyData);

    if (!config.production) {
      await publishYesterdaySensorsFromData(groupedEnergyData, costsData, userConfig.overhead);
    }

    if (!isSyncingNeeded) {
      debug('Skipping statistics sync (already up-to-date)');
      return;
    }

    const firstDay = dayjs(lastStatistic.start).add(1, 'day');
    const fullData = await client.getEnergyData(firstDay);

    const energyStatistics = formatAsStatistics(groupDataPointsByHour(fullData));

    await haClient.saveStatistics({
      prm: config.prm,
      name: config.name,
      isProduction: config.production,
      stats: incrementSums(energyStatistics, lastStatistic.sum),
    });

    if (config.costs) {
      const entityHistory = await fetchEntityHistory(haClient, config.costs, fullData);
      const costs = computeCosts(fullData, config.costs, entityHistory);

      const costsStatistics = formatAsStatistics(groupDataPointsByHour(costs));

      if (costsStatistics.length > 0) {
        const lastCostStatistic = await haClient.findLastStatistic({
          prm: config.prm,
          isProduction: config.production,
          isCost: true,
        });

        await haClient.saveStatistics({
          prm: config.prm,
          name: config.name,
          isProduction: config.production,
          isCost: true,
          stats: incrementSums(costsStatistics, lastCostStatistic?.sum || 0),
        });
      }
    }
  }

  async function fetchEntityHistory(
    haClient: HomeAssistantClient,
    costConfigs: MeterConfig['costs'],
    energyData: DataPoint[],
  ): Promise<EntityHistoryData | undefined> {
    if (!costConfigs || costConfigs.length === 0) return undefined;

    const entityIds = [...new Set(costConfigs.map(c => c.entity_id!).filter(Boolean))];

    const startTime = dayjs(energyData[0].date).subtract(1, 'day').toISOString();
    const endTime = dayjs(energyData[energyData.length - 1].date).add(1, 'day').toISOString();

    const entityHistory: EntityHistoryData = {};

    for (const entityId of entityIds) {
      try {
        entityHistory[entityId] = await haClient.getEntityHistory({
          entityId,
          startTime,
          endTime,
        });
      } catch (e) {
        warn(`History fetch failed for ${entityId}`);
        entityHistory[entityId] = [];
      }
    }

    return entityHistory;
  }

  for (const config of userConfig.meters) {
    if (config.action === 'sync') {
      await sync(config);
    }
  }

  haClient.disconnect();

  const randomMinute = Math.floor(Math.random() * 59);
  const randomSecond = Math.floor(Math.random() * 59);

  info(
    `Data synchronization planned every day at ` +
      `06:${randomMinute.toString().padStart(2, '0')}:${randomSecond.toString().padStart(2, '0')} and ` +
      `09:${randomMinute.toString().padStart(2, '0')}:${randomSecond.toString().padStart(2, '0')}`,
  );

  cron.schedule(`${randomSecond} ${randomMinute} 6,9 * * *`, async () => {
    await haClient.connect();

    for (const config of userConfig.meters) {
      if (config.action === 'sync') {
        await sync(config);
      }
    }

    haClient.disconnect();
  });
}

try {
  await main();
} catch (e) {
  error(e.toString());
  process.exit(1);
}
