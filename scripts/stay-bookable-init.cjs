#!/usr/bin/env node
// 兼容入口：旧 stay_bookable 已由房源级 online_booking / online_payment 取代。
// 保留旧脚本名，避免部署手册或历史任务调用失败；实际执行新版幂等迁移。
'use strict';

require('./transaction-capabilities-init.cjs');
