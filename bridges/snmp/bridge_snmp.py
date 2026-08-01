#!/usr/bin/env python3
"""BetterDesk CDAP — SNMP v2c/v3 Bridge.

Periodically polls SNMP OIDs and pushes values to BetterDesk via CDAP.
Supports counter-rate computation, timetick formatting, and byte formatting.

Usage:
    pip install betterdesk-cdap pysnmp
    python bridge_snmp.py --config config.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import time
from pathlib import Path
from typing import Any

from betterdesk_cdap import CDAPBridge, gauge, textWidget

logger = logging.getLogger("bridge_snmp")

# ── Value transforms ──────────────────────────────────────────────────


def format_timeticks(value: int) -> str:
    """Convert SNMP TimeTicks (1/100s) to human-readable uptime."""
    secs = int(value) // 100
    days, rem = divmod(secs, 86400)
    hours, rem = divmod(rem, 3600)
    mins, rem = divmod(rem, 60)
    return f"{days}d {hours:02d}:{mins:02d}:{rem:02d}"


def format_bytes_kb(value: int) -> str:
    """Format kilobytes to human-readable string."""
    kb = int(value)
    if kb >= 1048576:
        return f"{kb / 1048576:.1f} GB"
    if kb >= 1024:
        return f"{kb / 1024:.1f} MB"
    return f"{kb} KB"


def apply_transform(raw: Any, transform: str) -> Any:
    """Apply simple arithmetic transform expressed as '100 - x'."""
    if not transform:
        return raw
    try:
        x = float(raw)
        return eval(transform, {"__builtins__": {}}, {"x": x})  # noqa: S307 — safe: restricted builtins
    except Exception:
        return raw


# ── Bridge ────────────────────────────────────────────────────────────


class SNMPBridge:
    """SNMP ↔ CDAP bridge."""

    def __init__(self, cfg: dict[str, Any]):
        self.cfg = cfg
        self.scfg = cfg["snmp"]
        self.oids: list[dict] = cfg.get("oids", [])
        self._prev_counters: dict[str, tuple[float, float]] = {}  # oid → (timestamp, value)

        cdap = cfg["cdap"]
        self.bridge = CDAPBridge(
            server=cdap["server"],
            auth_method="api_key",
            api_key=cdap.get("api_key", ""),
            device_name=cdap.get("device_name", "SNMP Bridge"),
            device_type=cdap.get("device_type", "bridge"),
            bridge_name=cdap.get("bridge_name", "snmp"),
            bridge_version="1.0.0",
            heartbeat_sec=cdap.get("heartbeat_sec", 15),
        )

        self._build_widgets()

    def _build_widgets(self) -> None:
        for entry in self.oids:
            wtype = entry.get("widget", "text")
            wid = entry["widget_id"]
            label = entry.get("label", wid)

            if wtype == "gauge":
                self.bridge.add_widget(
                    gauge(wid, label, unit=entry.get("unit", ""), min_val=entry.get("min", 0), max_val=entry.get("max", 100))
                )
            else:
                self.bridge.add_widget(textWidget(wid, label))

    # ── SNMP engine ───────────────────────────────────────────────

    async def _snmp_get(self, oid: str) -> Any:
        from pysnmp.hlapi.v3arch.asyncio import (
            CommunityData,
            ContextData,
            ObjectIdentity,
            ObjectType,
            SnmpEngine,
            UdpTransportTarget,
            UsmUserData,
            get_cmd,
            usmAesCfb128Protocol,
            usmHMACSHAAuthProtocol,
        )

        version = self.scfg.get("version", "2c")
        target = await UdpTransportTarget.create(
            (self.scfg["host"], self.scfg.get("port", 161)),
            timeout=self.scfg.get("timeout_sec", 5),
            retries=1,
        )

        if version == "3":
            auth_proto = usmHMACSHAAuthProtocol
            priv_proto = usmAesCfb128Protocol
            cred = UsmUserData(
                self.scfg.get("v3_user", ""),
                authKey=self.scfg.get("v3_auth_key", ""),
                privKey=self.scfg.get("v3_priv_key", ""),
                authProtocol=auth_proto,
                privProtocol=priv_proto,
            )
        else:
            cred = CommunityData(self.scfg.get("community", "public"))

        engine = SnmpEngine()
        error_indication, error_status, error_index, var_binds = await get_cmd(
            engine, cred, target, ContextData(), ObjectType(ObjectIdentity(oid))
        )

        if error_indication or error_status:
            logger.warning("SNMP error for %s: %s / %s", oid, error_indication, error_status)
            return None

        for _, val in var_binds:
            return val

        return None

    def _compute_rate(self, oid: str, raw: float) -> float | None:
        """Compute per-second rate from SNMP counter."""
        now = time.monotonic()
        prev = self._prev_counters.get(oid)
        self._prev_counters[oid] = (now, raw)
        if prev is None:
            return None
        dt = now - prev[0]
        if dt <= 0:
            return None
        return max(0.0, (raw - prev[1]) / dt)

    # ── Poll loop ─────────────────────────────────────────────────

    async def _poll_loop(self) -> None:
        interval = self.scfg.get("poll_interval_sec", 10)
        logger.info("SNMP polling %s:%s every %ds", self.scfg["host"], self.scfg.get("port", 161), interval)

        while True:
            updates: dict[str, Any] = {}
            for entry in self.oids:
                try:
                    raw = await self._snmp_get(entry["oid"])
                    if raw is None:
                        continue

                    fmt = entry.get("format", "")
                    transform = entry.get("transform", "")

                    if fmt == "timeticks":
                        updates[entry["widget_id"]] = format_timeticks(raw)
                    elif fmt == "bytes_kb":
                        updates[entry["widget_id"]] = format_bytes_kb(raw)
                    elif fmt == "counter_rate":
                        rate = self._compute_rate(entry["oid"], float(raw))
                        if rate is not None:
                            updates[entry["widget_id"]] = round(rate, 2)
                    else:
                        val = apply_transform(raw, transform) if transform else raw
                        try:
                            updates[entry["widget_id"]] = float(val)
                        except (ValueError, TypeError):
                            updates[entry["widget_id"]] = str(val)

                except Exception as exc:
                    logger.warning("Poll %s failed: %s", entry["widget_id"], exc)

            if updates:
                self.bridge.bulk_update(updates)

            await asyncio.sleep(interval)

    # ── Entry point ───────────────────────────────────────────────

    def run(self) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        async def _main() -> None:
            poll_task = asyncio.create_task(self._poll_loop())
            cdap_task = asyncio.create_task(self.bridge._run_forever())
            done, pending = await asyncio.wait(
                [poll_task, cdap_task], return_when=asyncio.FIRST_EXCEPTION
            )
            for t in done:
                if t.exception():
                    logger.error("Task failed: %s", t.exception())
            for t in pending:
                t.cancel()

        try:
            loop.run_until_complete(_main())
        except KeyboardInterrupt:
            logger.info("Shutting down")
        finally:
            loop.close()


# ── CLI ───────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(description="BetterDesk CDAP SNMP Bridge")
    parser.add_argument("--config", "-c", default="config.json", help="Path to config file")
    parser.add_argument("--log-level", "-l", default="INFO", choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    args = parser.parse_args()

    logging.basicConfig(level=getattr(logging, args.log_level), format="%(asctime)s [%(name)s] %(levelname)s %(message)s")

    path = Path(args.config)
    if not path.is_file():
        logger.error("Config file not found: %s", path)
        sys.exit(1)

    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)

    bridge = SNMPBridge(cfg)
    bridge.run()


if __name__ == "__main__":
    main()
