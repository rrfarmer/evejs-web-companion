import datetime
from cosmetics.client.shipSkinSequencingSvc import get_ship_skin_sequencing_svc
from cosmetics.client.ships.skins.live_data.sequencing_job import SequencingJob, SequencingJobState
from localization import GetByLabel

prefix = 'UI/Personalization/ShipSkins/SKINR/Studio/'
now = datetime.datetime.now()
job = SequencingJob(None, 'probe', session.charid, 2)
job.admin_set_state(SequencingJobState.STARTED)
job.admin_set_started_time(now - datetime.timedelta(minutes=28))
job.admin_set_planned_completion_time(now + datetime.timedelta(minutes=32, seconds=10))
values = dict(progress=job.get_completed_ratio(), remaining=job.get_time_remaining_text())
sequencing = get_ship_skin_sequencing_svc()
try:
    values['price'] = sequencing._get_early_completion_cost_from_job(job)
    values['bands'] = sequencing._cached_time_limits_and_prices
except Exception as error:
    values['quoteError'] = type(error).__name__
job.admin_set_state(SequencingJobState.COMPLETED)
values['completedProgress'] = job.get_completed_ratio()

result = dict(station=session.stationid, runs=job.nb_runs, values=values,
              complete=GetByLabel(prefix + 'CompleteJobNow'),
              timeLeft=GetByLabel(prefix + 'TimeLeft', time_left='DURATION'))
