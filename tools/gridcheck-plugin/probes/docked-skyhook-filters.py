# Read the native Skyhook filters and exercise their character settings.
from eve.client.script.ui.structure.structureBrowser.controllers.filterContController import FilterContControllerSkyhook
from eve.client.script.ui.structure.structureBrowser.browserUIConst import UI_SETTING_SKYHOOKBROWSER_FILTERS

first = FilterContControllerSkyhook()
regions = first.GetRegionOptions()
location = first.GetLocationOptions()
state = first.GetStateOptions()
theft = first.GetTheftVulnerabilityOptions()
keys = [UI_SETTING_SKYHOOKBROWSER_FILTERS % field for field in ('location', 'region', 'state', 'theftvulnerability')]
original = [settings.char.ui.Get(key, None) for key in keys]
try:
    first.SetSelectedLocationOption(-1)
    first.SetSelectedRegionOption(regions[1][1])
    first.SetSelectedStateOption('reinforced')
    first.SetSelectedTheftVulnerabilityOption('secure')
    first.TextFilterChanged('example')
    reopened = FilterContControllerSkyhook()
    persisted = [reopened.GetSelectedLocationOption(), reopened.GetSelectedRegionOption(),
                 reopened.GetSelectedStateOption(), reopened.GetSelectedTheftVulnerabilityOption()]
    text = reopened.GetTextFilter()
finally:
    for key, value in zip(keys, original):
        settings.char.ui.Set(key, value)
result = {'regions': regions, 'location': location, 'state': state, 'theft': theft,
          'reopened': persisted, 'search': text, 'keys': keys}
