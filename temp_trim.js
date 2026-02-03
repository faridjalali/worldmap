function trimEuropeGeometry(features) {
  for (const f of features) {
    const id = pad3(f.id);

    // France (250): Remove French Guiana (South America)
    // French Guiana is approx lon -53. Mainland is lon -5 to 10.
    if (id === "250" && f.geometry && f.geometry.type === "MultiPolygon") {
      f.geometry.coordinates = f.geometry.coordinates.filter(polygon => {
        // Check longitude of the first point in the first ring
        const [lon] = polygon[0][0]; 
        // Keep if longitude is > -20 (East of Atlantic)
        return lon > -20;
      });
    }

    // Russia (643): Remove parts near Alaska (crosses 180 to negative lon)
    // Most of Russia is positive lon (20E to 180E). 
    // The "Alaska tip" is negative lon (e.g. -170).
    if (id === "643" && f.geometry && f.geometry.type === "MultiPolygon") {
      f.geometry.coordinates = f.geometry.coordinates.filter(polygon => {
        const [lon] = polygon[0][0];
        // Keep if longitude is >= 0 (Eastern Hemisphere)
        return lon >= 0;
      });
    }
  }
}
