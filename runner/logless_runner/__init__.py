"""logless sandbox runner — runs analysis programs in disposable, network-less containers.

This service holds no API keys. It accepts a program plus typed, text-free input files from the
app VM (bearer-token auth), runs it once in a fresh container, and returns the bounded output
and an execution receipt. See docs/CONTRACTS.md §9."""

__version__ = "0.1.0"
