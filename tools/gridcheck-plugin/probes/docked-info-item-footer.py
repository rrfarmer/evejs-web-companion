import blue
import evetypes
from eve.client.script.ui.shared.info.infoConst import DATA_BUTTONS
from localization import GetByLabel


def observe():
    info = sm.GetService('info')
    cases = []
    relic = next(type_id for type_id in sorted(evetypes.GetTypeIDsByCategory(34)) if evetypes.IsPublished(type_id))
    for type_id in (34, 35912, 784, 785, 53530, 81348, 82340, relic):
        window = info.ShowInfo(type_id, new=1)
        try:
            for attempt in range(65):
                if hasattr(window.info_content, 'data') and not window.isLoading:
                    break
                blue.pyos.synchro.SleepWallclock(100)
            else:
                raise RuntimeError('Show Info did not load type %s' % type_id)
            actions = window.info_content.data[DATA_BUTTONS]
            row = dict(typeID=type_id, category=evetypes.GetCategoryID(type_id), name=evetypes.GetName(type_id),
                       actions=[entry[0] for entry in actions], commands=[entry[1].__name__ for entry in actions])
            industry = [entry for entry in actions if entry[0] == GetByLabel('UI/Industry/ViewInIndustry')]
            if industry:
                item_id, blueprint_type, blueprint = industry[0][2]
                row['blueprint'] = dict(itemID=item_id, typeID=blueprint_type, original=getattr(blueprint, 'original', None))
            cases.append(row)
        finally:
            window.Close()
    return dict(build=3698585, station=session.stationid, cases=cases)


result = observe()
