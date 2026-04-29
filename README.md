# ha-linky-plus

> A fork of [ha-linky](https://github.com/bokub/ha-linky) by [bokub](https://github.com/bokub) — all credit for the original implementation goes to him.

## What's new in ha-linky-plus

The original ha-linky syncs your Linky smart meter data directly into Home Assistant's **long-term statistics database**. This works great for the native Energy dashboard, but those statistics are invisible to templates, markdown cards, and ApexCharts — because they are not real HA sensor entities.

**ha-linky-plus** adds two real HA sensor entities that are updated automatically every day alongside the statistics sync:

| Entity | Description |
|---|---|
| `sensor.linky_yesterday_kwh` | Yesterday's total consumption in kWh |
| `sensor.linky_yesterday_cost` | Yesterday's total cost in € (tariff + configurable daily overhead) |

These sensors can be used anywhere in Home Assistant — markdown cards, template sensors, ApexCharts, automations, and more.
<img
  src="https://github.com/user-attachments/assets/015abb5b-e903-44ba-b68f-ff6102b51428"
  style="height: 480px; width: auto; align: left;"
/>

## How it works

After each sync cycle, ha-linky-plus:

1. Fetches yesterday's consumption data from Enedis via Conso API
2. Groups it by hour (matching the statistics granularity)
3. Computes the cost using your configured HC/HP tariff
4. Adds a configurable daily overhead (subscription + taxes)
5. Pushes both values to HA as real sensor states via the REST API

## Installation

Build the Docker image:

```bash
docker build https://github.com/sudarsanyes/ha-linky-plus.git -f standalone.Dockerfile -t ha-linky-plus
```

Or clone locally for easier rebuilds:

```bash
cd ~/docker/ha
git clone https://github.com/sudarsanyes/ha-linky-plus.git
docker build --no-cache -f ha-linky-plus/standalone.Dockerfile ha-linky-plus -t ha-linky-plus
```

## Configuration

`options.json` follows the same format as the original ha-linky, with one addition — the `overhead` field:

```json
{
  "overhead": 0.826,
  "meters": [
    {
      "prm": "YOUR_PRM",
      "token": "YOUR_CONSO_API_TOKEN",
      "name": "Linky",
      "action": "sync",
      "production": false
    }
  ],
  "costs": [
    { "price": 0.1579, "before": "06:00" },
    { "price": 0.2065, "after": "06:00", "before": "15:00" },
    { "price": 0.1579, "after": "15:00", "before": "17:00" },
    { "price": 0.2065, "after": "17:00", "before": "24:00" }
  ]
}
```

### `overhead`
Daily fixed cost in € to add on top of the raw tariff cost (subscription, taxes, etc).  
Default: `0.826` €/day (~25.60 €/month).  
This value is read at runtime — changing it only requires a container restart, not a rebuild.

## Docker Compose

```yaml
services:
  ha-linky:
    image: ha-linky-plus
    restart: unless-stopped
    environment:
      - SUPERVISOR_TOKEN=your_long_lived_token
      - WS_URL=ws://homeassistant:8123/api/websocket
      - TZ=Europe/Paris
    volumes:
      - ./ha-linky:/data
    networks:
      - homeassistant
```

## Update schedule

Sensors are refreshed automatically:
- Once between **06:00 and 07:00** — picks up yesterday's data
- Once between **09:00 and 10:00** — fallback if the first run failed

## Example dashboard card

```yaml
type: markdown
content: |
  ## ⚡ Yesterday ({{ state_attr('sensor.linky_yesterday_kwh', 'date') }})
  **{{ states('sensor.linky_yesterday_kwh') }} kWh** — **{{ states('sensor.linky_yesterday_cost') }} €**
```

## Rebuilding after changes

```bash
docker build --no-cache -f ~/docker/ha/ha-linky-plus/standalone.Dockerfile ~/docker/ha/ha-linky-plus -t ha-linky-plus
cd ~/docker/ha
docker compose up -d --force-recreate ha-linky
docker logs ha-ha-linky-1 -f
```

## Credits

Original project: [ha-linky](https://github.com/bokub/ha-linky) by [Boris K (bokub)](https://github.com/bokub)  
Standalone Docker deployment concept and all core sync logic are his work.  
This fork adds real sensor entity publishing on top of the existing statistics pipeline.
