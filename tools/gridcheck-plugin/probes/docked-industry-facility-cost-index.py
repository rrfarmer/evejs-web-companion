import industry
from localization import GetByLabel


def observe():
    service = sm.GetService('facilitySvc')
    facilities = [row for row in service.GetFacilities() if row.solarSystemID == session.solarsystemid2]
    maxima = {activity: service.GetMaxActivityModifier(activity) for activity in industry.ACTIVITIES}
    return {
        'station': session.stationid,
        'label': GetByLabel('UI/Industry/SystemCostIndex'),
        'hint': GetByLabel('UI/Industry/SystemCostIndexHint'),
        'maxima': maxima,
        'facilities': [{'facility': row.facilityID,
                        'activities': [[activity, amount, '%.2f%%' % (amount * 100.0), amount / maxima[activity]]
                                       for activity, amount in sorted(row.GetCostIndexByActivityID().items())]}
                       for row in facilities]}


result = observe()
