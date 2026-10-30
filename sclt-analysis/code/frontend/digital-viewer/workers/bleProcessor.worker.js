/* eslint-disable no-restricted-globals */

// 状态管理
const state = {
  beacons: [],
  hasPlayBle: [],
  categoryNameMap: new Map()
};

// 构建分类映射
const buildCategoryMap = (beacons) => {
  // 这里简化处理，实际可能需要传入完整的分类树
  // 在Worker中我们主要关注计算，分类名称映射可以返回ID，由主线程处理
};

const normalizeSubPoints = (subPoints) => {
  if (Array.isArray(subPoints)) {
    return subPoints;
  }
  if (typeof subPoints === 'string' && subPoints.trim()) {
    try {
      const parsed = JSON.parse(subPoints);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }
  return [];
};

const createBeaconPosition = (item) => ({
  x: (item?.xcoordinate ?? item?.xCoordinate) || 0,
  y: (item?.ycoordinate ?? item?.yCoordinate) || 0,
  level: +(item.floorKey || 1),
});

const getMinorLength = (minor) => String(minor ?? '').length;

const getBleUuidPrefix = (item, subPoints) => {
  const uuid = item?.uuid ?? '';
  const major = item?.major ?? '';
  if (`${uuid}${major}`) {
    return `${uuid}${major}`;
  }
  const mainBleUuid = String(item?.bleUuid ?? '');
  if (!mainBleUuid) {
    return '';
  }
  const minorLength =
    getMinorLength(item?.minor) || getMinorLength(subPoints?.[0]?.minor);
  if (!minorLength || mainBleUuid.length <= minorLength) {
    return '';
  }
  return mainBleUuid.slice(0, -minorLength);
};

const buildBeaconScanEntries = (item) => {
  const mainBleUuid = item?.bleUuid;
  const subPoints = normalizeSubPoints(item?.subPoints);
  const bleUuidPrefix = getBleUuidPrefix(item, subPoints);
  const subPointEntries = subPoints.map((subPoint) => ({
    scanBleUuid: `${bleUuidPrefix}${subPoint?.minor ?? ''}`,
    effectiveDistance: subPoint?.effectiveDistance ?? item?.effectiveDistance,
  }));
  const entries = [
    {
      scanBleUuid: mainBleUuid,
      effectiveDistance: item?.effectiveDistance,
    },
    ...subPointEntries,
  ].filter((entry) => entry.scanBleUuid);

  return {
    subPoints,
    entries,
    groupBleUuids: entries.map((entry) => entry.scanBleUuid),
  };
};

// 处理扫描数据 (RSSI/距离)
const processScanData = (data) => {
  console.log('processScanData', data, state.beacons);
  if (!state.beacons.length || !data) return [];

  return state.beacons
    .map((item) => {
      const { subPoints, entries, groupBleUuids } = buildBeaconScanEntries(item);
      const matchedEntry = entries
        .filter((entry) => data[entry.scanBleUuid] !== undefined)
        .reduce((closest, current) => {
          if (!closest) {
            return current;
          }
          return data[current.scanBleUuid] < data[closest.scanBleUuid]
            ? current
            : closest;
        }, null);

      if (!matchedEntry) {
        return null;
      }

      return {
        ...item,
        bleUuid: item?.bleUuid,
        matchedBleUuid:
          subPoints.length && matchedEntry.scanBleUuid !== item?.bleUuid
            ? matchedEntry.scanBleUuid
            : undefined,
        realDistance: data[matchedEntry.scanBleUuid],
        effectiveDistance: matchedEntry.effectiveDistance,
        groupBleUuids: subPoints.length ? groupBleUuids : undefined,
        showRoomName: String(item?.categoryId),
        position: createBeaconPosition(item),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.realDistance - b.realDistance);
};

// 处理坐标数据 (AoA/UWB)
const processCoordinates = (coords) => {
  if (!state.beacons.length) return { nearbyBeacons: [], currentPosition: coords };

  const x = coords.x;
  const y = coords.y;
  
  // 计算楼层
  const level = typeof coords.z === 'number' 
    ? Math.round(coords.z / 3) + 1 
    : coords.currentLevel;

  // 距离筛选逻辑
  const beaconsInRange = state.beacons
    .map((item) => {
      const itemX = (item?.xcoordinate ?? item?.xCoordinate) || 0;
      const itemY = (item?.ycoordinate ?? item?.yCoordinate) || 0;

      // 计算主坐标欧氏距离
      const mainDistance = Math.sqrt(
        Math.pow(itemX - x, 2) + Math.pow(itemY - y, 2)
      );

      // 遍历副坐标，取所有副坐标中最小的距离
      const subCoordinates = normalizeSubPoints(item?.subCoordinates);
      const minSubDistance = subCoordinates.reduce((minDist, sub) => {
        const subX = (sub?.xcoordinate ?? sub?.xCoordinate) || 0;
        const subY = (sub?.ycoordinate ?? sub?.yCoordinate) || 0;
        if (!subX && !subY) return minDist;
        const d = Math.sqrt(Math.pow(subX - x, 2) + Math.pow(subY - y, 2));
        return d < minDist ? d : minDist;
      }, Infinity);

      // 取主坐标和副坐标的最小距离作为最终距离
      const distance = subCoordinates.length > 0
        ? Math.min(mainDistance, minSubDistance)
        : mainDistance;

      return {
        ...item,
        realDistance: distance,
        showRoomName: String(item.categoryId),
        position: {
          x: itemX,
          y: itemY,
          level: +(item.floorKey || 1),
        },
      };
    })
    // 筛选8米内且同楼层的信标
    .filter((item) => item.realDistance <= 8 && item.position.level === level)
    .sort((a, b) => a.realDistance - b.realDistance);

  return {
    nearbyBeacons: beaconsInRange,
    currentPosition: { x, y, level }
  };
};

self.onmessage = (e) => {
  const { type, payload } = e.data;
  console.log('Worker received:', type, payload);
  
  switch (type) {
    case 'INIT_BEACONS':
      state.beacons = payload;
      console.log('Beacons initialized:', state.beacons.length);
      break;

    case 'PROCESS_SCAN_DATA':
      try {
        const scanResult = processScanData(payload);
        console.log('scanResult', scanResult);
        self.postMessage({
          type: 'SCAN_RESULT',
          payload: scanResult
        });
      } catch (err) {
        console.error('Error processing scan data:', err);
      }
      break;

    case 'PROCESS_COORDINATES':
      try {
        const coordResult = processCoordinates(payload);
        self.postMessage({
          type: 'COORDINATES_RESULT',
          payload: coordResult
        });
      } catch (err) {
        console.error('Error processing coordinates:', err);
      }
      break;
      
    case 'RESET_HISTORY':
      state.hasPlayBle = [];
      break;
  }
};
