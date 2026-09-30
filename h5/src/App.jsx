import { Navigate, Route, Routes } from 'react-router-dom';
import AppShell from './components/AppShell.jsx';
import Home from './pages/Home.jsx';
import Search from './pages/Search.jsx';
import Spots from './pages/Spots.jsx';
import Orders from './pages/Orders.jsx';
import Me from './pages/Me.jsx';
import Detail from './pages/Detail.jsx';
import Booking from './pages/Booking.jsx';
import Paid from './pages/Paid.jsx';

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Home />} />
        <Route path="search" element={<Search />} />
        <Route path="spots" element={<Spots />} />
        <Route path="orders" element={<Orders />} />
        <Route path="me" element={<Me />} />
        <Route path="detail/:id" element={<Detail />} />
        <Route path="booking/:id" element={<Booking />} />
        <Route path="booking" element={<Booking />} />
        <Route path="paid" element={<Paid />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
