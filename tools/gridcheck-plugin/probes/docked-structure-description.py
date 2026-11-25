# Open and read the native description editor without submitting a change.
from localization import GetByLabel
from eve.client.script.ui.structure.structureBrowser.entries.structureEntryMyCorp import SetStrucureDescriptionWnd, IsContentComplianceControlSystemActive

window = SetStrucureDescriptionWnd.Open(windowID='codexStructureDescriptionProbe',
                                      structureID=1030000000000L,
                                      currentName='Fixture Astrahus', currentDesc='First line\nSecond line')
try:
    result = {'caption': GetByLabel(window.default_captionLabelPath),
              'maxLength': window.maxLength, 'description': window.descField.GetValue(),
              'compliance': bool(IsContentComplianceControlSystemActive(sm.GetService('machoNet')))}
finally:
    window.Close()
