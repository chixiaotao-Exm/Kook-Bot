"""Read-only Palworld telemetry and authoritative game-event ingestion."""

from .events import BridgeUnavailable, EventBridge

__all__ = ["BridgeUnavailable", "EventBridge"]
