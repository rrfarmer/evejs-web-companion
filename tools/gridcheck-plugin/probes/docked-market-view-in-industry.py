import blue
from eve.client.script.ui.shared.industry.industryWnd import Industry
from localization import GetByLabel


def observe():
    if Industry.GetIfOpen():
        return {'alreadyOpen': True}
    try:
        rows = []
        window = None
        for type_id in (785, 32881, 30752):
            if window and not window.IsViewCollapsed():
                window.CollapseView(animate=False)
            Industry.OpenOrShowBlueprint(None, type_id)
            current = Industry.GetIfOpen()
            for _ in xrange(30):
                if current.jobData and current.jobData.blueprint.blueprintTypeID == type_id:
                    break
                blue.synchro.SleepWallclock(100)
            job = current.jobData
            bp = job.blueprint
            rows.append({'type': bp.blueprintTypeID, 'item': job.blueprintID,
                         'activity': job.activityID, 'facility': job.facilityID,
                         'original': bp.original, 'runs': job.runs,
                         'expanded': not current.IsViewCollapsed(),
                         'reused': window is not None and current is window})
            window = current
        return {'station': session.stationid, 'label': GetByLabel('UI/Industry/ViewInIndustry'), 'rows': rows}
    finally:
        window = Industry.GetIfOpen()
        if window:
            if window.IsViewCollapsed():
                window.ExpandView(animate=False)
            window.Close()


result = observe()
