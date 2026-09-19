-- Pull in the wezterm API
local wezterm = require("wezterm")

-- This will hold the configuration.
local config = wezterm.config_builder()

-- This is where you actually apply your config choices

-- Font configuration (JetBrainsMono primary, Maple Mono fallback for VN/CJK)
config.font = wezterm.font_with_fallback({
  { family = "JetBrainsMono NF", weight = "Regular" },
  "Maple Mono NF",
  "Apple Color Emoji",
  "PingFang SC",
})
config.font_size = 13.0
config.warn_about_missing_glyphs = false

-- Kitty keyboard protocol — REQUIRED for pi-tui (Shift+Enter, Ctrl+V image paste, ...)
config.enable_kitty_keyboard = true
config.enable_kitty_graphics = true

-- Pi quality-of-life
config.audible_bell = "Disabled"
config.adjust_window_size_when_changing_font_size = false

config.scrollback_lines = 50000
config.use_resize_increments = true

-- Disable tab bar
config.enable_tab_bar = false

-- Window size configuration
config.initial_cols = 160  -- Width in columns
config.initial_rows = 50   -- Height in rows

-- Window appearance (optimized for performance)
config.window_decorations = "RESIZE"
-- Reduced transparency for better performance
config.window_background_opacity = 0.8  -- Less transparent
-- Reduced blur for better performance
config.macos_window_background_blur = 10   -- Less blur

-- Cursor configuration
config.default_cursor_style = "SteadyUnderline"

-- Performance optimizations
config.webgpu_power_preference = "HighPerformance"
config.front_end = "WebGpu"  -- Try WebGpu for better performance

-- Disable animations that might cause issues
config.animation_fps = 60
config.max_fps = 60

-- my coolnight colorscheme:
config.colors = {
	foreground = "#CBE0F0",
	background = "#011423",
	cursor_bg = "#47FF9C",
	cursor_border = "#47FF9C",
	cursor_fg = "#011423",
	selection_bg = "#033259",
	selection_fg = "#CBE0F0",
	ansi = { "#214969", "#E52E2E", "#44FFB1", "#FFE073", "#0FC5ED", "#a277ff", "#24EAF7", "#24EAF7" },
	brights = { "#214969", "#E52E2E", "#44FFB1", "#FFE073", "#A277FF", "#a277ff", "#24EAF7", "#24EAF7" },
}

-- and finally, return the configuration to wezterm

wezterm.on('update-right-status', function(window, pane)
  local info = pane:get_foreground_process_info()
  local name = info and (info.name or info.executable or "") or ""
  local overrides = window:get_config_overrides() or {}

  if name:find("nvim") then
    overrides.font = wezterm.font_with_fallback({
      { family = "Monaspace Neon", weight = 500,
        harfbuzz_features = {
          "calt=1","liga=1",
          "ss01=1","ss02=1","ss03=1","ss04=1","ss05=1",
          "ss06=1","ss07=1","ss08=1","ss09=1","ss10=1",
          "cv01=2",
        },
      },
      "monospace",
    })
    overrides.font_size = 12
  else
    overrides.font = nil
    overrides.font_size = nil
  end

  window:set_config_overrides(overrides)
end)

-- Shift+Enter override removed: pi-tui handles it natively via Kitty keyboard protocol.
-- Adding a custom SendString here causes ambiguity (alt+enter vs shift+enter).

-- macOS binds Option+Enter to fullscreen; send CSI-u instead so pi receives
-- Alt+Enter (queue follow-up message).
config.keys = {
  { key = 'Enter', mods = 'ALT', action = wezterm.action.SendString('\x1b[13;3u') },
}

return config
