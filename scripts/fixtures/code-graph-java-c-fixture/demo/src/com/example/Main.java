package com.example;

import com.example.Order;
import com.example.Service;

public class Main {
    public static void main(String[] args) {
        Order order = new Order(1, "coffee");
        Service service = new Service();
        int total = service.total(order);
        System.out.println(total);
    }
}
