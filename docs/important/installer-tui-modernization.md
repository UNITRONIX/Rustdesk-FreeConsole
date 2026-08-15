# Installer TUI Modernization (all 3 ALL-IN-ONE scripts)

Goal: arrow-key TUI look across betterdesk.sh, betterdesk-docker.sh, betterdesk.ps1.

## Pattern
- bash: `tui_select` engine + `menu_choose "Title" "Subtitle"` sets `$MENU_CHOICE`.
  Caller builds `_menu_items=( $'Label\tDesc' )` + `_menu_returns=( 1 2 0 )`, then
  feeds `$MENU_CHOICE` into UNCHANGED `case` block. Cancel returns LAST token.
- PS1: `Invoke-TuiSelect` engine (~L275) + `Invoke-MenuChoose -Title -Subtitle -Items @("Label`tDesc") -Returns @("1","0")`
  sets `$script:MENU_CHOICE`. Feeds into UNCHANGED `switch`. Cancel returns last entry.
  `Test-TuiAvailable` honors BETTERDESK_CLASSIC_MENU=1, AUTO_MODE, IsInputRedirected.

## Status: COMPLETE (all 3 scripts)
- betterdesk.sh: all menus + main. `bash -n` OK.
- betterdesk-docker.sh: TUI ported, main + 7 sub-menus. `bash -n` OK.
- betterdesk.ps1: 10 menus via Invoke-MenuChoose (DatabaseType, update-method, repair,
  password-reset, diagnostics, paths, SSL, protocol-toggle, build, migration) +
  main menu via Invoke-TuiSelect with menuLabels/menuActions. PowerShell AST
  parsing is now enforced by `.github/workflows/installer-ci.yml`; runtime
  install/update tests still require a Windows environment.

## Rules learned
- Keep emoji OUT of printf/PadRight TUI labels (renderer counts 1 cell, term shows 2). Use ASCII `->`, `+--+`.
- Data-entry prompts (host/port/password/paths/domain) stay plain read/Read-Host. Only MENUS convert.
- menu_choose/Invoke-MenuChoose keep SAME return tokens the existing case/switch expects.
- Docker SSL menu originally had no back option -> added `0` + `0) return ;;`.
- Run `bash -n` after each bash script. CI parses every official Bash and
  PowerShell installer; runtime install/update tests remain an environment
  validation step.
- Classic fallback: BETTERDESK_CLASSIC_MENU=1 (bash) / $env:BETTERDESK_CLASSIC_MENU=1 (ps1).
