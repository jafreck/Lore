import React, { useState, useEffect } from 'react';
import * as lodash from 'lodash';

function App() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    lodash.debounce(() => {}, 100);
  }, []);
  return count;
}
