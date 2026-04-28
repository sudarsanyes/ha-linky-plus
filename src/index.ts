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
  .replace('/websocket', '');

const TOKEN = process.env.SUPERVISOR_TOKEN;

async function publishYesterdaySensorsFromData(
  energyData: DataPoint[],
  costsData: DataPoint[] | undefined,
  overhead = 0.826,
) {
  const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');

  const yesterdayEnergy = energyData.filter(d =>
    dayjs(d.date).format('YYYY-MM-DD') === yesterday
  );

  if (yesterdayEnergy.length === 0) {
    warn('No energy data found for yesterday');
    return;
  }

  const whYesterday = yesterdayEnergy.reduce((sum, d) => sum + d.value, 0);
  const kwhYesterday = Number((whYesterday / 1000).toFixed(2));

  let costWithOverhead = 0;

  if (costsData && costsData.length > 0) {
    const yesterdayCosts = costsData.filter(d =>
      dayjs(d.date).format('YYYY-MM-DD') === yesterday
    );

    const costRaw = yesterdayCosts.reduce((sum, d) => sum + d.value, 0);
    costWithOverhead = Number((costRaw + overhead).toFixed(2));
  }

  const headers = {
    'Authorization': `Bearer ${TOKEN}`,
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
    warn(`Failed to push kWh sensor: ${res1.status} ${await res1.text()}`);
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
    warn(`Failed to push cost sensor: ${res2.status} ${await res2.text()}`);
  }

  debug(`Pushed yesterday sensors: ${kwhYesterday} kWh / ${costWithOverhead} € (${yesterday})`);
}

async function main() {
  debug('HA Linky is starting');

  const userConfig = getUserConfig();

  if (userConfig.meters.length === 0) {
    warn('Add-on is not configured properly');
    debug('HA Linky stopped');
    return;
  }

  const haClient = new HomeAssistantClient();
  await haClient.connect();

  for (const config of userConfig.meters) {
    if (config.action === 'reset') {
      await haClient.purge(config.prm, config.production);
      info(`Statistics removed successfully for PRM ${config.prm} !`);
    }
  }

  if (userConfig.meters.every((config) => config.action !== 'sync')) {
    haClient.disconnect();
    info('Nothing to sync');
    debug('HA Linky stopped');
    return;
  }

  async function sync(config: MeterConfig) {
    info(
      `[${dayjs().format('DD/MM HH:mm')}] Synchronization started for ${
        config.production ? 'production' : 'consumption'
      } data`,
    );

    const lastStatistic = await haClient.findLastStatistic({
      prm: config.prm,
      isProduction: config.production,
    });

    if (!lastStatistic) {
      warn(`Data synchronization failed, no previous statistic found in Home Assistant`);
      return;
    }

    const isSyncingNeeded =
      dayjs(lastStatistic.start).isBefore(dayjs().subtract(2, 'days')) &&
      dayjs().hour() >= 6;

    if (!isSyncingNeeded) {
      debug('Everything is up-to-date, nothing to synchronize');
      return;
    }

    const client = new LinkyClient(config.token, config.prm, config.production);
    const firstDay = dayjs(lastStatistic.start).add(1, 'day');
    const energyData = await client.getEnergyData(firstDay);

    const energyStatistics = formatAsStatistics(groupDataPointsByHour(energyData));

    await haClient.saveStatistics({
      prm: config.prm,
      name: config.name,
      isProduction: config.production,
      stats: incrementSums(energyStatistics, lastStatistic.sum),
    });

    let costsData: DataPoint[] | undefined;

    if (config.costs) {
      const entityHistory = await fetchEntityHistory(haClient, config.costs, energyData);
      const costs = computeCosts(energyData, config.costs, entityHistory);
      costsData = costs;

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

    // ✅ New: publish yesterday immediately (no delay, no HA read)
    if (!config.production) {
      await publishYesterdaySensorsFromData(energyData, costsData);
    }
  }

  async function fetchEntityHistory(
    haClient: HomeAssistantClient,
    costConfigs: MeterConfig['costs'],
    energyData: DataPoint[],
  ): Promise<EntityHistoryData | undefined> {
    if (!costConfigs || costConfigs.length === 0) {
      return undefined;
    }

    const entityIds = [...new Set(costConfigs.filter((c) => c.entity_id).map((c) => c.entity_id!))];

    if (entityIds.length === 0) {
      return undefined;
    }

    const startTime = dayjs(energyData[0].date).subtract(1, 'day').toISOString();
    const endTime = dayjs(energyData[energyData.length - 1].date).add(1, 'day').toISOString();

    const entityHistory: EntityHistoryData = {};

    for (const entityId of entityIds) {
      try {
        const history = await haClient.getEntityHistory({
          entityId,
          startTime,
          endTime,
        });
        entityHistory[entityId] = history;
      } catch (e) {
        warn(`Failed to fetch history for entity ${entityId}: ${e.toString()}`);
        entityHistory[entityId] = [];
      }
    }

    return entityHistory;
  }

  for (const config of userConfig.meters) {
    if (config?.action === 'sync') {
      const isNew = await haClient.isNewPRM({
        prm: config.prm,
        isProduction: config.production,
      });

      if (!isNew) {
        await sync(config);
      }
    }
  }

  haClient.disconnect();

  const randomMinute = Math.floor(Math.random() * 59);
  const randomSecond = Math.floor(Math.random() * 59);

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
