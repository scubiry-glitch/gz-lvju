import { Navigate, Route, Routes } from 'react-router-dom';
import AppShell from './components/AppShell.jsx';
import RequireAuth from './components/RequireAuth.jsx';
import Home from './pages/Home.jsx';
import Search from './pages/Search.jsx';
import Spots from './pages/Spots.jsx';
import Orders from './pages/Orders.jsx';
import Me from './pages/Me.jsx';
import Detail from './pages/Detail.jsx';
import Booking from './pages/Booking.jsx';
import Paid from './pages/Paid.jsx';
import Minsu from './pages/Minsu.jsx';
import Changzu from './pages/Changzu.jsx';
import Guide from './pages/Guide.jsx';
import Lvju from './pages/Lvju.jsx';
import RoutesPage from './pages/Routes.jsx';
import Food from './pages/Food.jsx';
import Convenience from './pages/Convenience.jsx';
import SpotPost from './pages/SpotPost.jsx';

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Home />} />
        <Route path="search" element={<Search />} />
        <Route path="lvju" element={<Lvju />} />
        <Route path="minsu" element={<Minsu />} />
        <Route path="changzu" element={<Changzu />} />
        <Route path="guide" element={<Guide />} />
        <Route path="spots" element={<Spots />} />
        <Route path="routes" element={<RoutesPage />} />
        <Route path="food" element={<Food />} />
        <Route path="convenience" element={<Convenience />} />
        <Route path="spot/:id" element={<SpotPost />} />
        <Route path="detail/:id" element={<Detail />} />
        <Route path="paid" element={<Paid />} />
        <Route element={<RequireAuth />}>
          <Route path="orders" element={<Orders />} />
          <Route path="me" element={<Me />} />
          <Route path="booking/:id" element={<Booking />} />
          <Route path="booking" element={<Booking />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
