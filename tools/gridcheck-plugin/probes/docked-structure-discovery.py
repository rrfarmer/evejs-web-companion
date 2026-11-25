# Read native Structure Browser choices and results without changing the saved filters.
from eve.client.script.ui.structure.structureBrowser.filterContUtil import GetLocationOptions
from eve.client.script.ui.structure.structureBrowser.structureBrowserWnd import StructureBrowserWnd
from eve.client.script.ui.structure.structureBrowser.entries.structureEntry import StructureEntry

window = StructureBrowserWnd.GetIfOpen()
already_open = window is not None
if not already_open:
    window = StructureBrowserWnd.Open()
try:
    panel = window.browserAllStructures
    filters = panel.filterContController
    ranges = GetLocationOptions()
    result = {
        'ranges': ranges,
        'defaultRange': filters.GetRange(),
        'columns': StructureEntry.GetHeaders([]),
        'services': [[entry.serviceID, entry.name, entry.label] for entry in filters._GetSortedServiceOption()],
        'locations': [[range_id, sorted(row.GetItemID() for row in window.controller.GetAllStructures(range_id))]
                      for range_id in ranges],
    }
finally:
    if not already_open:
        window.Close()
