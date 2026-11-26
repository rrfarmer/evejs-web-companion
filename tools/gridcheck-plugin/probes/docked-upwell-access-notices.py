from eve.client.script.ui.services.structure.structureServices import StructureServices
from eve.client.script.ui.services.structure.structureDirectory import StructureDirectory
from eve.client.script.ui.station import stationServiceConst

service = stationServiceConst.serviceDataByNameID['market']
result = dict(serviceNotice='OnStructureServiceChanged' in StructureServices.__notifyevents__,
              directoryNotice='OnDockingAccessChangedForCurrentSolarSystem' in StructureDirectory.__notifyevents__,
              marketService=service.serviceID, marketBlocksClick=service.disableButtonIfNotAvailable,
              station=session.stationid)
